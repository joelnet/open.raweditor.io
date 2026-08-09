import { test } from "node:test";
import assert from "node:assert/strict";
import { CURVE, LUMA } from "../constants.js";
import {
  ZERO_CURVE,
  isIdentityCurve,
  isIdentityPoints,
  curveMap,
  buildCurveLut,
  sampleCurveLut,
  applyCurveLut,
} from "../curve.js";
import { ZERO_SETTINGS, toneMapRows, srgbEncode } from "../tone-math.js";

const EPS = 1e-9;

/** @param {Partial<import("../curve.js").ToneCurve>} patch */
function curve(patch) {
  return { ...ZERO_CURVE, ...patch };
}

test("identity detection", () => {
  assert.ok(isIdentityCurve(ZERO_CURVE));
  assert.ok(
    isIdentityPoints([
      [0, 0],
      [1, 1],
    ]),
  );
  assert.ok(
    !isIdentityPoints([
      [0, 0.05],
      [1, 1],
    ]),
  );
  assert.ok(
    !isIdentityCurve(
      curve({
        r: [
          [0, 0],
          [0.5, 0.6],
          [1, 1],
        ],
      }),
    ),
  );
});

test("identity curve LUT is a no-op for any refine-saturation", () => {
  const lut = buildCurveLut(ZERO_CURVE);
  for (const sat of [0, 0.5, 1]) {
    for (const v of [0, 0.121, 0.5, 0.87, 1]) {
      const [r, g, b] = applyCurveLut(lut, sat, v, 0.5 * v, 1 - v);
      assert.ok(Math.abs(r - v) < 1e-6, `r at ${v}`);
      assert.ok(Math.abs(g - 0.5 * v) < 1e-6, `g at ${v}`);
      assert.ok(Math.abs(b - (1 - v)) < 1e-6, `b at ${v}`);
    }
  }
});

test("the spline interpolates its control points exactly", () => {
  const points = /** @type {const} */ ([
    [0, 0],
    [0.25, 0.1],
    [0.5, 0.6],
    [0.8, 0.75],
    [1, 1],
  ]);
  const f = curveMap(points);
  for (const [x, y] of points) {
    assert.ok(Math.abs(f(x) - y) < EPS, `at ${x}`);
  }
});

test("monotone input stays monotone (Fritsch-Carlson never overshoots)", () => {
  // clustered points like these make a natural cubic spline oscillate
  const f = curveMap([
    [0, 0],
    [0.1, 0.02],
    [0.12, 0.7],
    [0.13, 0.71],
    [0.9, 0.95],
    [1, 1],
  ]);
  let prev = f(0);
  for (let i = 1; i <= 1000; i++) {
    const y = f(i / 1000);
    assert.ok(y >= prev - EPS, `dip at ${i / 1000}: ${y} < ${prev}`);
    assert.ok(y >= 0 && y <= 1);
    prev = y;
  }
});

test("outside the end points the curve extends along the end tangents", () => {
  const f = curveMap([
    [0.2, 0.3],
    [0.8, 0.7],
  ]);
  // straight segment: tangent = secant = 2/3, extended linearly then clamped
  assert.ok(Math.abs(f(0.1) - (0.3 - (2 / 3) * 0.1)) < EPS);
  assert.ok(Math.abs(f(0.95) - (0.7 + (2 / 3) * 0.15)) < EPS);
  assert.ok(Math.abs(f(0) - (0.3 - (2 / 3) * 0.2)) < EPS);
});

test("degenerate points never divide by zero", () => {
  const f = curveMap([
    [0.5, 0.2],
    [0.5, 0.9],
  ]);
  for (const x of [0, 0.5, 1]) assert.ok(Number.isFinite(f(x)));
  const single = curveMap([[0.4, 0.6]]);
  assert.equal(single(0), 0.6);
  assert.equal(single(1), 0.6);
  const empty = curveMap([]);
  assert.equal(empty(0.3), 0.3);
});

test("LUT sampling matches the spline at entry positions", () => {
  const c = curve({
    master: [
      [0, 0],
      [0.4, 0.55],
      [1, 1],
    ],
  });
  const lut = buildCurveLut(c);
  const f = curveMap(c.master);
  for (const i of [0, 100, 511, 777, CURVE.LUT_SIZE - 1]) {
    const x = i / (CURVE.LUT_SIZE - 1);
    assert.ok(Math.abs(sampleCurveLut(lut, 3, x) - f(x)) < 1e-6, `entry ${i}`);
  }
});

test("channel curves apply before the master curve", () => {
  const rCurve = /** @type {const} */ ([
    [0, 0.2],
    [1, 0.2],
  ]); // r → constant 0.2
  const master = /** @type {const} */ ([
    [0, 0.5],
    [1, 0.5],
  ]); // everything → 0.5
  const lut = buildCurveLut(curve({ r: rCurve, master }));
  const [r] = applyCurveLut(lut, 1, 0.9, 0.9, 0.9);
  // master(channel(x)) = master(0.2) = 0.5 — not channel(master(x)) = 0.2
  assert.ok(Math.abs(r - 0.5) < 1e-6);
});

test("refine-saturation 0 preserves channel ratios under the master curve", () => {
  const master = /** @type {const} */ ([
    [0, 0],
    [0.25, 0.15],
    [0.75, 0.85],
    [1, 1],
  ]);
  const lut = buildCurveLut(curve({ master }));
  const [r, g, b] = applyCurveLut(lut, 0, 0.6, 0.3, 0.15);
  assert.ok(Math.abs(r / g - 2) < 1e-4);
  assert.ok(Math.abs(g / b - 2) < 1e-4);
  // and the luma lands where the master curve puts it
  const y = LUMA[0] * 0.6 + LUMA[1] * 0.3 + LUMA[2] * 0.15;
  const yOut = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  assert.ok(Math.abs(yOut - sampleCurveLut(lut, 3, y)) < 1e-6);
});

test("refine-saturation 1 applies the master per channel", () => {
  const master = /** @type {const} */ ([
    [0, 0],
    [0.25, 0.15],
    [0.75, 0.85],
    [1, 1],
  ]);
  const lut = buildCurveLut(curve({ master }));
  const [r, g, b] = applyCurveLut(lut, 1, 0.6, 0.3, 0.15);
  assert.ok(Math.abs(r - sampleCurveLut(lut, 3, 0.6)) < 1e-6);
  assert.ok(Math.abs(g - sampleCurveLut(lut, 3, 0.3)) < 1e-6);
  assert.ok(Math.abs(b - sampleCurveLut(lut, 3, 0.15)) < 1e-6);
});

test("refine-saturation does not touch per-channel curves", () => {
  const lut = buildCurveLut(
    curve({
      r: [
        [0, 0],
        [0.5, 0.7],
        [1, 1],
      ],
    }),
  );
  const full = applyCurveLut(lut, 1, 0.3, 0.3, 0.3);
  const neutral = applyCurveLut(lut, 0, 0.3, 0.3, 0.3);
  // identity master → both applications equal the channel-curved pixel
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(full[i] - neutral[i]) < 1e-6, `channel ${i}`);
  }
  assert.ok(full[0] > full[1]); // and the red lift is really there
});

test("contrast presets pin middle gray and stay monotone", () => {
  for (const preset of [CURVE.MEDIUM_CONTRAST, CURVE.STRONG_CONTRAST]) {
    const f = curveMap(preset);
    assert.ok(Math.abs(f(128 / 255) - 128 / 255) < EPS);
    assert.ok(f(32 / 255) < 32 / 255); // shadows pulled down
    assert.ok(f(192 / 255) > 192 / 255); // highlights lifted
    let prev = f(0);
    for (let i = 1; i <= 255; i++) {
      const y = f(i / 255);
      assert.ok(y >= prev - EPS);
      prev = y;
    }
  }
});

test("toneMapRows applies the curve like the shader's step 8.5", () => {
  const image = {
    data: Uint16Array.of(
      13107,
      13107,
      13107,
      65535, // 0.2 gray
      45875,
      45875,
      45875,
      65535, // 0.7 gray
    ),
    width: 2,
    height: 1,
    colors: 4,
    bits: 16,
  };
  const master = /** @type {const} */ ([
    [0, 0],
    [0.25, 0.15],
    [0.75, 0.85],
    [1, 1],
  ]);
  const settings = { ...ZERO_SETTINGS, curve: curve({ master }) };
  const out = new Uint8ClampedArray(2 * 4);
  toneMapRows(image, settings, out, 0, 1);
  const lut = buildCurveLut(settings.curve);
  for (const [i, v] of [
    [0, 0.2],
    [1, 0.7],
  ]) {
    const [expected] = applyCurveLut(lut, 1, ...Array(3).fill(srgbEncode(v)));
    assert.ok(
      Math.abs(out[i * 4] / 255 - expected) < 1.5 / 255,
      `pixel ${i}: ${out[i * 4]} vs ${expected * 255}`,
    );
  }
});
