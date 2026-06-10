import { test } from "node:test";
import assert from "node:assert/strict";
import { TONE } from "../constants.js";
import {
  ZERO_SETTINGS,
  applyTonePixel,
  srgbEncode,
  srgbDecode,
  toneMapRows,
} from "../tone-math.js";

const EPS = 1e-9;

/** @param {Partial<import("../tone-math.js").ToneSettings>} patch */
function settings(patch) {
  return { ...ZERO_SETTINGS, ...patch };
}

test("zero settings is identity (sRGB encode of clamped input)", () => {
  for (const v of [0, 0.01, 0.18, 0.5, 0.99, 1, 1.5]) {
    const [r, g, b] = applyTonePixel(v, v, v, ZERO_SETTINGS);
    const expected = srgbEncode(Math.min(v, 1));
    assert.ok(Math.abs(r - expected) < EPS, `value ${v}: ${r} != ${expected}`);
    assert.equal(r, g);
    assert.equal(g, b);
  }
});

test("exposure +1 EV equals doubling linear input", () => {
  for (const v of [0.05, 0.1, 0.2, 0.4]) {
    const [withEv] = applyTonePixel(v, v, v, settings({ exposure: 1 }));
    const [doubled] = applyTonePixel(2 * v, 2 * v, 2 * v, ZERO_SETTINGS);
    assert.ok(Math.abs(withEv - doubled) < EPS, `value ${v}`);
  }
});

test("exposure -1 EV equals halving linear input", () => {
  const [withEv] = applyTonePixel(0.4, 0.4, 0.4, settings({ exposure: -1 }));
  const [halved] = applyTonePixel(0.2, 0.2, 0.2, ZERO_SETTINGS);
  assert.ok(Math.abs(withEv - halved) < EPS);
});

test("temp +1 warms: red up, blue down, green untouched", () => {
  const v = 0.18;
  const [r, g, b] = applyTonePixel(v, v, v, settings({ temp: 1 }));
  const [base] = applyTonePixel(v, v, v, ZERO_SETTINGS);
  const up = srgbEncode(v * Math.pow(2, TONE.WB_TEMP_EV));
  const down = srgbEncode(v * Math.pow(2, -TONE.WB_TEMP_EV));
  assert.ok(Math.abs(r - up) < EPS);
  assert.ok(Math.abs(g - base) < EPS);
  assert.ok(Math.abs(b - down) < EPS);
});

test("temp -1 cools: blue up, red down", () => {
  const v = 0.18;
  const [r, , b] = applyTonePixel(v, v, v, settings({ temp: -1 }));
  const [base] = applyTonePixel(v, v, v, ZERO_SETTINGS);
  assert.ok(r < base);
  assert.ok(b > base);
});

test("tint moves green: +1 toward magenta, -1 toward green", () => {
  const v = 0.18;
  const [base] = applyTonePixel(v, v, v, ZERO_SETTINGS);
  const [rM, gM, bM] = applyTonePixel(v, v, v, settings({ tint: 1 }));
  assert.ok(gM < base);
  assert.ok(Math.abs(rM - base) < EPS);
  assert.ok(Math.abs(bM - base) < EPS);
  const [, gG] = applyTonePixel(v, v, v, settings({ tint: -1 }));
  assert.ok(gG > base);
});

test("contrast keeps the middle-gray pivot fixed", () => {
  const p = TONE.PIVOT;
  for (const c of [-1, -0.5, 0.5, 1]) {
    const [out] = applyTonePixel(p, p, p, settings({ contrast: c }));
    const [base] = applyTonePixel(p, p, p, ZERO_SETTINGS);
    assert.ok(Math.abs(out - base) < EPS, `contrast ${c}`);
  }
});

test("contrast is monotonic over a ramp", () => {
  for (const c of [-1, 1]) {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = i / 100;
      const [out] = applyTonePixel(v, v, v, settings({ contrast: c }));
      assert.ok(out >= prev - EPS, `contrast ${c}, value ${v}`);
      prev = out;
    }
  }
});

test("whites endpoints remap the white point", () => {
  // whites = +1 → white point at 1 - WHITES_RANGE; that input now hits 1.0
  const wp = 1 - TONE.WHITES_RANGE;
  const [hi] = applyTonePixel(wp, wp, wp, settings({ whites: 1 }));
  assert.ok(Math.abs(hi - 1) < EPS);
  // whites = -1 → white point at 1 + WHITES_RANGE; input 1.0 no longer clips
  const [lo] = applyTonePixel(1, 1, 1, settings({ whites: -1 }));
  assert.ok(lo < 1);
});

test("blacks endpoints remap the black point", () => {
  // blacks = -1 → black point at BLACKS_RANGE; that input crushes to 0
  const bp = TONE.BLACKS_RANGE;
  const [lo] = applyTonePixel(bp, bp, bp, settings({ blacks: -1 }));
  assert.ok(Math.abs(lo) < EPS);
  // blacks = +1 → black point lifted; input 0 comes out above 0
  const [hi] = applyTonePixel(0, 0, 0, settings({ blacks: 1 }));
  assert.ok(hi > 0);
});

test("shadows raise dark pixels, leave bright pixels alone", () => {
  const [darkUp] = applyTonePixel(0.02, 0.02, 0.02, settings({ shadows: 1 }));
  const [darkBase] = applyTonePixel(0.02, 0.02, 0.02, ZERO_SETTINGS);
  assert.ok(darkUp > darkBase);
  const [brightUp] = applyTonePixel(0.9, 0.9, 0.9, settings({ shadows: 1 }));
  const [brightBase] = applyTonePixel(0.9, 0.9, 0.9, ZERO_SETTINGS);
  assert.ok(Math.abs(brightUp - brightBase) < EPS);
});

test("highlights cut bright pixels, leave dark pixels alone", () => {
  const s = settings({ highlights: -1 });
  const [brightDown] = applyTonePixel(0.9, 0.9, 0.9, s);
  const [brightBase] = applyTonePixel(0.9, 0.9, 0.9, ZERO_SETTINGS);
  assert.ok(brightDown < brightBase);
  const [darkDown] = applyTonePixel(0.02, 0.02, 0.02, s);
  const [darkBase] = applyTonePixel(0.02, 0.02, 0.02, ZERO_SETTINGS);
  assert.ok(Math.abs(darkDown - darkBase) < EPS);
});

test("output stays in [0,1] under extreme settings", () => {
  const extremes = [
    settings({ exposure: 5, contrast: 1, shadows: 1, blacks: 1, temp: 1 }),
    settings({
      exposure: -5,
      contrast: -1,
      highlights: -1,
      whites: -1,
      temp: -1,
      tint: 1,
    }),
    settings({ exposure: 5, whites: 1, highlights: 1, tint: -1 }),
  ];
  for (const s of extremes) {
    for (const v of [0, 0.18, 1, 4]) {
      const out = applyTonePixel(v, v, v, s);
      for (const ch of out) {
        assert.ok(ch >= 0 && ch <= 1, `settings ${JSON.stringify(s)} v=${v}`);
      }
    }
  }
});

test("sRGB encode/decode round-trips", () => {
  for (let i = 0; i <= 20; i++) {
    const v = i / 20;
    assert.ok(Math.abs(srgbDecode(srgbEncode(v)) - v) < 1e-12);
  }
});

test("toneMapRows matches applyTonePixel and fills alpha (3-channel u16)", () => {
  const width = 2;
  const height = 2;
  const data = new Uint16Array([
    0, 0, 0, 65535, 65535, 65535, 11796, 23593, 35389, 6553, 6553, 6553,
  ]);
  const image = { data, width, height, colors: 3, bits: 16 };
  const out = new Uint8ClampedArray(width * height * 4);
  toneMapRows(image, ZERO_SETTINGS, out, 0, height);
  for (let p = 0; p < 4; p++) {
    const r = data[p * 3] / 65535;
    const g = data[p * 3 + 1] / 65535;
    const b = data[p * 3 + 2] / 65535;
    const [er, eg, eb] = applyTonePixel(r, g, b, ZERO_SETTINGS);
    const expected = new Uint8ClampedArray([er * 255, eg * 255, eb * 255]);
    assert.equal(out[p * 4], expected[0]);
    assert.equal(out[p * 4 + 1], expected[1]);
    assert.equal(out[p * 4 + 2], expected[2]);
    assert.equal(out[p * 4 + 3], 255);
  }
});

test("toneMapRows handles 4-channel input and row ranges", () => {
  const width = 2;
  const height = 2;
  // RGBA u16: 4th channel must be ignored
  const data = new Uint16Array(width * height * 4).fill(32768);
  const image = { data, width, height, colors: 4, bits: 16 };
  const out = new Uint8ClampedArray(width * height * 4);
  toneMapRows(image, ZERO_SETTINGS, out, 1, 2); // bottom row only
  assert.equal(out[0], 0); // top row untouched
  assert.ok(out[2 * 4] > 0); // bottom row written
  assert.equal(out[2 * 4 + 3], 255);
});
