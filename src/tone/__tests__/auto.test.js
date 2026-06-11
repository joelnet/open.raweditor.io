import { test } from "node:test";
import assert from "node:assert/strict";
import { TONE } from "../constants.js";
import { autoWhiteBalance, autoTone } from "../auto.js";

const NEUTRAL_WB = { temp: 0, tint: 0 };

/**
 * Build a preview buffer from a per-pixel linear RGB generator.
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} fn linear 0..1
 */
function makePreview(width, height, fn) {
  const pixels = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * 4;
      pixels[i] = Math.min(Math.max(Math.round(r * 65535), 0), 65535);
      pixels[i + 1] = Math.min(Math.max(Math.round(g * 65535), 0), 65535);
      pixels[i + 2] = Math.min(Math.max(Math.round(b * 65535), 0), 65535);
      pixels[i + 3] = 65535;
    }
  }
  return { pixels, width, height };
}

/** @param {{ width: number, height: number }} preview */
function fullRect({ width, height }) {
  return { x: 0, y: 0, w: width, h: height };
}

/** Gray ramp lo..hi across x. @param {number} lo @param {number} hi */
function grayRamp(lo, hi) {
  return makePreview(512, 128, (x) => {
    const v = lo + (hi - lo) * (x / 511);
    return /** @type {[number, number, number]} */ ([v, v, v]);
  });
}

// --- auto white balance ---

test("auto WB on a neutral image is identity", () => {
  const preview = grayRamp(0.02, 0.8);
  const { temp, tint } = autoWhiteBalance(preview, fullRect(preview));
  assert.ok(Math.abs(temp) <= 0.02, `temp ${temp}`);
  assert.ok(Math.abs(tint) <= 0.02, `tint ${tint}`);
});

test("auto WB undoes a baked-in temp cast", () => {
  // bake the cast the pipeline itself would produce at temp = +0.3
  const cr = 2 ** (TONE.WB_TEMP_EV * 0.3);
  const cb = 2 ** (-TONE.WB_TEMP_EV * 0.3);
  const preview = makePreview(512, 128, (x) => {
    const v = 0.02 + 0.58 * (x / 511);
    return /** @type {[number, number, number]} */ ([v * cr, v, v * cb]);
  });
  const { temp, tint } = autoWhiteBalance(preview, fullRect(preview));
  assert.ok(Math.abs(temp - -0.3) <= 0.03, `temp ${temp} != -0.3`);
  assert.ok(Math.abs(tint) <= 0.03, `tint ${tint}`);
});

test("auto WB undoes a baked-in green cast via tint", () => {
  // green gain the pipeline would produce at tint = -0.4
  const cg = 2 ** (TONE.WB_TINT_EV * 0.4);
  const preview = makePreview(512, 128, (x) => {
    const v = 0.02 + 0.58 * (x / 511);
    return /** @type {[number, number, number]} */ ([v, v * cg, v]);
  });
  const { temp, tint } = autoWhiteBalance(preview, fullRect(preview));
  assert.ok(Math.abs(temp) <= 0.03, `temp ${temp}`);
  assert.ok(Math.abs(tint - 0.4) <= 0.03, `tint ${tint} != 0.4`);
});

test("auto WB ignores a dominant colored subject", () => {
  // 70% moderately saturated red passes the stage-1 saturation filter and
  // would wreck plain gray world; near-gray refinement must not budge.
  const preview = makePreview(512, 128, (x) =>
    x < 358
      ? /** @type {[number, number, number]} */ ([0.5, 0.06, 0.06])
      : /** @type {[number, number, number]} */ ([0.3, 0.3, 0.3]),
  );
  const { temp, tint } = autoWhiteBalance(preview, fullRect(preview));
  assert.ok(Math.abs(temp) <= 0.05, `temp ${temp}`);
  assert.ok(Math.abs(tint) <= 0.05, `tint ${tint}`);
});

test("auto WB bails to identity without usable samples", () => {
  const black = makePreview(64, 64, () => [0, 0, 0]);
  assert.deepEqual(autoWhiteBalance(black, fullRect(black)), {
    temp: 0,
    tint: 0,
  });
});

// --- auto tone ---

test("auto tone bails to zero on a constant image", () => {
  const flat = makePreview(128, 128, () => [0.5, 0.5, 0.5]);
  const s = autoTone(flat, fullRect(flat), NEUTRAL_WB);
  assert.deepEqual(s, {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
  });
});

test("auto tone raises exposure on an underexposed image", () => {
  const dark = grayRamp(0.002, 0.06);
  const s = autoTone(dark, fullRect(dark), NEUTRAL_WB);
  assert.ok(s.exposure >= 1, `exposure ${s.exposure}`);
});

test("auto tone lowers exposure on an overexposed image", () => {
  const bright = grayRamp(0.3, 0.95);
  const s = autoTone(bright, fullRect(bright), NEUTRAL_WB);
  assert.ok(s.exposure <= -0.5, `exposure ${s.exposure}`);
});

test("auto tone leaves a well-exposed wide-range image mostly alone", () => {
  // geometric ramp centered on middle gray, ±2.5 EV
  const preview = makePreview(512, 128, (x) => {
    const v = TONE.PIVOT * 2 ** (-2.5 + 5 * (x / 511));
    return /** @type {[number, number, number]} */ ([v, v, v]);
  });
  const s = autoTone(preview, fullRect(preview), NEUTRAL_WB);
  assert.ok(Math.abs(s.exposure) <= 0.3, `exposure ${s.exposure}`);
});

test("auto tone stretches a hazy low-contrast image", () => {
  const hazy = grayRamp(0.1, 0.4);
  const s = autoTone(hazy, fullRect(hazy), NEUTRAL_WB);
  assert.ok(s.blacks < 0, `blacks ${s.blacks}`);
  assert.ok(s.whites > 0.5, `whites ${s.whites}`);
  assert.ok(s.contrast >= 0.1, `contrast ${s.contrast}`);
});

test("auto tone on a backlit scene stays conservative", () => {
  // dark foreground under a clipped sky: exposure must stay white-limited,
  // whites/highlights must not slam to -100, and the unreachable midtone
  // deficit must NOT be force-fed into shadows (washes the image out —
  // user feedback: auto shadows at +70 is way too much).
  const preview = makePreview(512, 128, (x) =>
    x < 128
      ? /** @type {[number, number, number]} */ ([1, 1, 1])
      : /** @type {[number, number, number]} */ ([
          0.02 + 0.18 * ((x - 128) / 383),
          0.02 + 0.18 * ((x - 128) / 383),
          0.02 + 0.18 * ((x - 128) / 383),
        ]),
  );
  const s = autoTone(preview, fullRect(preview), NEUTRAL_WB);
  assert.ok(s.exposure <= 0.35, `exposure ${s.exposure}`);
  assert.ok(s.whites > -0.9, `whites pegged: ${s.whites}`);
  assert.ok(s.highlights > -0.5, `highlights pegged: ${s.highlights}`);
  assert.ok(s.shadows <= 0.4, `shadows ${s.shadows}`);
});

test("auto tone respects an intentionally dark background", () => {
  // bright subject on a deliberately dark, dominant background (DSC08692
  // regression: a sunlit flower at f/1.2 over a shaded patio). The dark
  // mass is the scene's character — shadows must stay near zero.
  const preview = makePreview(512, 128, (x) => {
    if (x < 332) {
      const v = 0.003 + 0.027 * (x / 331); // 65 % deep-shadow background
      return /** @type {[number, number, number]} */ ([v, v, v]);
    }
    if (x < 434) {
      const v = 0.05 + 0.15 * ((x - 332) / 101); // 20 % midtone foliage
      return /** @type {[number, number, number]} */ ([v, v, v]);
    }
    const v = 0.5 + 0.5 * ((x - 434) / 77); // 15 % bright subject
    return /** @type {[number, number, number]} */ ([v, v, v]);
  });
  const s = autoTone(preview, fullRect(preview), NEUTRAL_WB);
  assert.ok(s.shadows <= 0.1, `shadows ${s.shadows}`);
  assert.ok(s.exposure <= 0.35, `exposure ${s.exposure}`);
});

test("auto tone honors the crop rect", () => {
  // left half dark, right half bright, each with its own ramp
  const preview = makePreview(512, 128, (x) =>
    x < 256
      ? /** @type {[number, number, number]} */ ([
          0.005 + 0.045 * (x / 255),
          0.005 + 0.045 * (x / 255),
          0.005 + 0.045 * (x / 255),
        ])
      : /** @type {[number, number, number]} */ ([
          0.4 + 0.5 * ((x - 256) / 255),
          0.4 + 0.5 * ((x - 256) / 255),
          0.4 + 0.5 * ((x - 256) / 255),
        ]),
  );
  const left = autoTone(preview, { x: 0, y: 0, w: 256, h: 128 }, NEUTRAL_WB);
  const right = autoTone(preview, { x: 256, y: 0, w: 256, h: 128 }, NEUTRAL_WB);
  assert.ok(left.exposure > 0.5, `left exposure ${left.exposure}`);
  assert.ok(right.exposure < 0, `right exposure ${right.exposure}`);
});

test("auto tone results land on slider steps", () => {
  const s = autoTone(grayRamp(0.05, 0.6), fullRect(grayRamp(0.05, 0.6)), {
    temp: 0.2,
    tint: -0.1,
  });
  const onStep = (/** @type {number} */ v, /** @type {number} */ step) =>
    Math.abs(v / step - Math.round(v / step)) < 1e-6;
  assert.ok(onStep(s.exposure, 0.05), `exposure ${s.exposure}`);
  for (const key of ["contrast", "highlights", "shadows", "whites", "blacks"]) {
    assert.ok(onStep(s[/** @type {keyof typeof s} */ (key)], 0.01), key);
  }
});
