import { test } from "node:test";
import assert from "node:assert/strict";
import { TONE } from "../constants.js";
import {
  ZERO_SETTINGS,
  applyTonePixel,
  applyDisplayEffects,
  srgbEncode,
  srgbDecode,
  toneMapRows,
  hueColor,
  gradeWeights,
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

test("saturation -1 produces grayscale at Rec.709 luma", () => {
  const [r, g, b] = applyTonePixel(0.4, 0.2, 0.1, settings({ saturation: -1 }));
  const y = 0.2126 * 0.4 + 0.7152 * 0.2 + 0.0722 * 0.1;
  const expected = srgbEncode(y);
  assert.ok(Math.abs(r - expected) < EPS);
  assert.equal(r, g);
  assert.equal(g, b);
});

test("saturation +1 doubles the distance from luma", () => {
  const s = settings({ saturation: 1 });
  const [r, , b] = applyTonePixel(0.3, 0.25, 0.2, s);
  const y = 0.2126 * 0.3 + 0.7152 * 0.25 + 0.0722 * 0.2;
  assert.ok(Math.abs(r - srgbEncode(y + (0.3 - y) * 2)) < EPS);
  assert.ok(Math.abs(b - srgbEncode(y + (0.2 - y) * 2)) < EPS);
});

test("saturation and vibrance leave neutral gray unchanged", () => {
  for (const v of [0.05, 0.18, 0.7]) {
    const [base] = applyTonePixel(v, v, v, ZERO_SETTINGS);
    for (const patch of [
      { saturation: 1 },
      { saturation: -1 },
      { vibrance: 1 },
      { vibrance: -1 },
    ]) {
      const [r, g, b] = applyTonePixel(v, v, v, settings(patch));
      assert.ok(Math.abs(r - base) < EPS, JSON.stringify(patch));
      assert.equal(r, g);
      assert.equal(g, b);
    }
  }
});

/** Chroma proxy: max - min of the sRGB-encoded output channels. */
function chroma(/** @type {[number, number, number]} */ out) {
  return Math.max(...out) - Math.min(...out);
}

test("positive vibrance boosts muted colors more than vivid ones", () => {
  const s = settings({ vibrance: 1 });
  const muted = /** @type {[number, number, number]} */ ([0.3, 0.27, 0.24]);
  const vivid = /** @type {[number, number, number]} */ ([0.5, 0.15, 0.05]);
  const gain = (/** @type {[number, number, number]} */ px) =>
    chroma(applyTonePixel(...px, s)) /
    chroma(applyTonePixel(...px, ZERO_SETTINGS));
  assert.ok(gain(muted) > gain(vivid));
  assert.ok(gain(vivid) >= 1 - EPS); // never desaturates
});

test("negative vibrance tames vivid colors more than muted ones", () => {
  const s = settings({ vibrance: -1 });
  const muted = /** @type {[number, number, number]} */ ([0.3, 0.27, 0.24]);
  const vivid = /** @type {[number, number, number]} */ ([0.5, 0.15, 0.05]);
  const keep = (/** @type {[number, number, number]} */ px) =>
    chroma(applyTonePixel(...px, s)) /
    chroma(applyTonePixel(...px, ZERO_SETTINGS));
  assert.ok(keep(vivid) < keep(muted));
  assert.ok(keep(muted) <= 1 + EPS); // never saturates
});

test("vibrance and saturation preserve Rec.709 luma", () => {
  const luma = (/** @type {[number, number, number]} */ [r, g, b]) =>
    0.2126 * srgbDecode(r) + 0.7152 * srgbDecode(g) + 0.0722 * srgbDecode(b);
  const base = luma(applyTonePixel(0.3, 0.25, 0.2, ZERO_SETTINGS));
  for (const patch of [
    { saturation: 0.5 },
    { saturation: -0.5 },
    { vibrance: 0.5 },
    { vibrance: -0.5 },
  ]) {
    const out = luma(applyTonePixel(0.3, 0.25, 0.2, settings(patch)));
    assert.ok(Math.abs(out - base) < 1e-6, JSON.stringify(patch));
  }
});

test("hueColor hits the primaries and secondaries", () => {
  assert.deepEqual(hueColor(0), [1, 0, 0]);
  assert.deepEqual(hueColor(1 / 6), [1, 1, 0]);
  assert.deepEqual(hueColor(2 / 6), [0, 1, 0]);
  assert.deepEqual(hueColor(3 / 6), [0, 1, 1]);
  assert.deepEqual(hueColor(4 / 6), [0, 0, 1]);
  assert.deepEqual(hueColor(5 / 6), [1, 0, 1]);
  assert.deepEqual(hueColor(1), [1, 0, 0]); // wraps
});

test("color mixer leaves neutral gray unchanged at any slider extreme", () => {
  for (const v of [0, 0.05, 0.18, 0.7, 1]) {
    const [base] = applyTonePixel(v, v, v, ZERO_SETTINGS);
    for (const patch of [
      { hslRedHue: 1, hslRedSat: 1, hslRedLum: 1 },
      { hslGreenSat: -1, hslBlueSat: -1, hslMagentaLum: -1 },
    ]) {
      const [r, g, b] = applyTonePixel(v, v, v, settings(patch));
      assert.ok(Math.abs(r - base) < EPS, JSON.stringify(patch));
      assert.equal(r, g);
      assert.equal(g, b);
    }
  }
});

test("color mixer band saturation -1 collapses its band to gray", () => {
  // saturated red: sat slider -1 zeroes HSV saturation, leaving value (max)
  const [r, g, b] = applyTonePixel(0.5, 0.1, 0.1, settings({ hslRedSat: -1 }));
  const expected = srgbEncode(0.5);
  assert.ok(Math.abs(r - expected) < EPS);
  assert.ok(Math.abs(g - expected) < EPS);
  assert.ok(Math.abs(b - expected) < EPS);
});

test("color mixer red sliders leave a pure green pixel alone", () => {
  const base = applyTonePixel(0.1, 0.5, 0.1, ZERO_SETTINGS);
  const out = applyTonePixel(
    0.1,
    0.5,
    0.1,
    settings({ hslRedHue: 1, hslRedSat: 1, hslRedLum: 1 }),
  );
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(out[c] - base[c]) < EPS, `channel ${c}`);
  }
});

test("color mixer hue +1 rotates red toward orange, -1 toward magenta", () => {
  const base = applyTonePixel(0.5, 0.1, 0.1, ZERO_SETTINGS);
  const toOrange = applyTonePixel(0.5, 0.1, 0.1, settings({ hslRedHue: 1 }));
  assert.ok(toOrange[1] > base[1] + 1e-3); // green channel rises
  assert.ok(Math.abs(toOrange[0] - base[0]) < EPS);
  assert.ok(Math.abs(toOrange[2] - base[2]) < EPS);
  const toMagenta = applyTonePixel(0.5, 0.1, 0.1, settings({ hslRedHue: -1 }));
  assert.ok(toMagenta[2] > base[2] + 1e-3); // blue channel rises
  assert.ok(Math.abs(toMagenta[0] - base[0]) < EPS);
  assert.ok(Math.abs(toMagenta[1] - base[1]) < EPS);
});

test("color mixer luminance +1 doubles its band, leaves others alone", () => {
  const lifted = applyTonePixel(0.2, 0.05, 0.05, settings({ hslRedLum: 1 }));
  const doubled = applyTonePixel(0.4, 0.1, 0.1, ZERO_SETTINGS);
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(lifted[c] - doubled[c]) < EPS, `channel ${c}`);
  }
  const other = applyTonePixel(0.2, 0.05, 0.05, settings({ hslGreenLum: 1 }));
  const base = applyTonePixel(0.2, 0.05, 0.05, ZERO_SETTINGS);
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(other[c] - base[c]) < EPS, `channel ${c}`);
  }
});

test("color mixer crossfades adjacent bands midway between centers", () => {
  // hue exactly between red (0°) and orange (30°): both bands weigh 1/2,
  // so opposite full hue shifts cancel. The mixer sees sRGB-encoded
  // values, so the 15° hue is constructed encoded: r max, b min,
  // (g-b)/(r-b) = 15/60 = 0.25.
  const er = 0.7;
  const eb = 0.2;
  const eg = eb + 0.25 * (er - eb);
  const px = /** @type {[number, number, number]} */ ([
    srgbDecode(er),
    srgbDecode(eg),
    srgbDecode(eb),
  ]);
  const base = applyTonePixel(...px, ZERO_SETTINGS);
  const out = applyTonePixel(
    ...px,
    settings({ hslRedHue: 1, hslOrangeHue: -1 }),
  );
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(out[c] - base[c]) < EPS, `channel ${c}`);
  }
});

test("gradeWeights: shadows own black, highlights own white", () => {
  const [s0, m0, h0] = gradeWeights(0, 0.5, 0);
  assert.equal(s0, 1);
  assert.equal(m0, 0);
  assert.equal(h0, 0);
  const [s1, m1, h1] = gradeWeights(1, 0.5, 0);
  assert.equal(s1, 0);
  assert.equal(m1, 0);
  assert.equal(h1, 1);
});

test("gradeWeights: balance shifts the shadow/highlight crossover", () => {
  const ye = 0.5;
  const [, , hBase] = gradeWeights(ye, 0.5, 0);
  const [sBase] = gradeWeights(ye, 0.5, 0);
  const [sPos, , hPos] = gradeWeights(ye, 0.5, 1);
  assert.ok(hPos > hBase); // +balance: highlights reach into darker tones
  assert.ok(sPos < sBase || sBase === 0);
  const [sNeg, , hNeg] = gradeWeights(ye, 0.5, -1);
  assert.ok(sNeg > sBase); // -balance: shadows reach into brighter tones
  assert.ok(hNeg < hPos);
});

test("gradeWeights: blending feathers the masks wider", () => {
  // at low blending this luma is pure midtone; high blending bleeds the
  // shadow and highlight masks into it
  const ye = 0.52;
  const [sTight, , hTight] = gradeWeights(ye, 0, 0);
  assert.equal(sTight, 0);
  assert.equal(hTight, 0);
  const [sWide, , hWide] = gradeWeights(ye, 1, 0);
  assert.ok(sWide > 0);
  assert.ok(hWide > 0);
});

test("grading at zero sat/lum is identity for any blending/balance", () => {
  for (const patch of [
    { gradeBlending: 0, gradeBalance: 1 },
    { gradeBlending: 1, gradeBalance: -1 },
    { gradeShadowHue: 0.3, gradeMidHue: 0.6, gradeHighHue: 0.9 },
  ]) {
    for (const v of [0, 0.05, 0.18, 0.6, 1]) {
      const [base] = applyTonePixel(v, v, v, ZERO_SETTINGS);
      const [out] = applyTonePixel(v, v, v, settings(patch));
      assert.ok(Math.abs(out - base) < EPS, JSON.stringify(patch));
    }
  }
});

test("shadow tint colors dark grays, leaves bright pixels alone", () => {
  const s = settings({ gradeShadowHue: 0, gradeShadowSat: 1 }); // red
  const dark = applyTonePixel(0.03, 0.03, 0.03, s);
  assert.ok(dark[0] > dark[1] + 1e-3); // pushed toward red
  assert.ok(Math.abs(dark[1] - dark[2]) < EPS);
  const bright = applyTonePixel(0.9, 0.9, 0.9, s);
  const [brightBase] = applyTonePixel(0.9, 0.9, 0.9, ZERO_SETTINGS);
  assert.ok(Math.abs(bright[0] - brightBase) < EPS);
});

test("highlight tint colors bright grays, leaves dark pixels alone", () => {
  const s = settings({ gradeHighHue: 4 / 6, gradeHighSat: 1 }); // blue
  const bright = applyTonePixel(0.85, 0.85, 0.85, s);
  assert.ok(bright[2] > bright[0] + 1e-3);
  const dark = applyTonePixel(0.03, 0.03, 0.03, s);
  const [darkBase] = applyTonePixel(0.03, 0.03, 0.03, ZERO_SETTINGS);
  assert.ok(Math.abs(dark[0] - darkBase) < EPS);
});

test("midtone tint colors middle gray, not the extremes", () => {
  const s = settings({ gradeMidHue: 2 / 6, gradeMidSat: 1 }); // green
  const mid = applyTonePixel(0.18, 0.18, 0.18, s);
  assert.ok(mid[1] > mid[0] + 1e-3);
  for (const v of [0, 1]) {
    const out = applyTonePixel(v, v, v, s);
    const base = applyTonePixel(v, v, v, ZERO_SETTINGS);
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(out[c] - base[c]) < 1e-3, `v=${v}`);
    }
  }
});

test("grading tints pin pure black and white", () => {
  const s = settings({
    gradeShadowHue: 0,
    gradeShadowSat: 1,
    gradeMidHue: 0.3,
    gradeMidSat: 1,
    gradeHighHue: 0.6,
    gradeHighSat: 1,
    gradeBlending: 1,
  });
  assert.deepEqual(applyTonePixel(0, 0, 0, s), [0, 0, 0]);
  for (const ch of applyTonePixel(1, 1, 1, s)) {
    assert.ok(Math.abs(ch - 1) < 1e-12);
  }
});

test("zone luminance lifts its zone, leaves the opposite end alone", () => {
  const sUp = settings({ gradeShadowLum: 1 });
  const [darkUp] = applyTonePixel(0.03, 0.03, 0.03, sUp);
  const [darkBase] = applyTonePixel(0.03, 0.03, 0.03, ZERO_SETTINGS);
  assert.ok(darkUp > darkBase);
  const [brightUp] = applyTonePixel(0.9, 0.9, 0.9, sUp);
  const [brightBase] = applyTonePixel(0.9, 0.9, 0.9, ZERO_SETTINGS);
  assert.ok(Math.abs(brightUp - brightBase) < EPS);

  const sDown = settings({ gradeHighLum: -1 });
  const [brightDown] = applyTonePixel(0.9, 0.9, 0.9, sDown);
  assert.ok(brightDown < brightBase);
  const [darkDown] = applyTonePixel(0.03, 0.03, 0.03, sDown);
  assert.ok(Math.abs(darkDown - darkBase) < EPS);
});

test("balance pushes a tint across the midtones", () => {
  // midgray under a highlight tint: only reachable with +balance
  const tint = { gradeHighHue: 0, gradeHighSat: 1 };
  const base = applyTonePixel(0.13, 0.13, 0.13, settings(tint));
  const pushed = applyTonePixel(
    0.13,
    0.13,
    0.13,
    settings({ ...tint, gradeBalance: 1 }),
  );
  assert.ok(chroma(pushed) > chroma(base));
});

test("output stays in [0,1] under extreme settings", () => {
  const extremes = [
    settings({
      exposure: 5,
      contrast: 1,
      shadows: 1,
      blacks: 1,
      temp: 1,
      saturation: 1,
      vibrance: 1,
    }),
    settings({
      exposure: -5,
      contrast: -1,
      highlights: -1,
      whites: -1,
      temp: -1,
      tint: 1,
      saturation: -1,
      vibrance: -1,
    }),
    settings({ exposure: 5, whites: 1, highlights: 1, tint: -1, vibrance: 1 }),
    settings({
      gradeShadowHue: 0,
      gradeShadowSat: 1,
      gradeShadowLum: 1,
      gradeMidHue: 0.5,
      gradeMidSat: 1,
      gradeMidLum: -1,
      gradeHighHue: 0.8,
      gradeHighSat: 1,
      gradeHighLum: 1,
      gradeBlending: 1,
      gradeBalance: -1,
    }),
    settings({
      hslRedHue: 1,
      hslRedSat: 1,
      hslRedLum: 1,
      hslOrangeHue: -1,
      hslOrangeSat: -1,
      hslOrangeLum: -1,
      hslYellowSat: 1,
      hslGreenLum: -1,
      hslAquaHue: 1,
      hslBlueSat: 1,
      hslBlueLum: 1,
      hslPurpleHue: -1,
      hslMagentaSat: -1,
      hslMagentaLum: 1,
    }),
  ];
  for (const s of extremes) {
    for (const v of [0, 0.18, 1, 4]) {
      for (const px of [
        [v, v, v],
        [v, v * 0.5, v * 0.1],
      ]) {
        const out = applyTonePixel(px[0], px[1], px[2], s);
        for (const ch of out) {
          assert.ok(ch >= 0 && ch <= 1, `settings ${JSON.stringify(s)} v=${v}`);
        }
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
  for (const s of [
    ZERO_SETTINGS,
    settings({ vibrance: 0.5, saturation: -0.3 }),
  ]) {
    const out = new Uint8ClampedArray(width * height * 4);
    toneMapRows(image, s, out, 0, height);
    for (let p = 0; p < 4; p++) {
      const r = data[p * 3] / 65535;
      const g = data[p * 3 + 1] / 65535;
      const b = data[p * 3 + 2] / 65535;
      const [er, eg, eb] = applyTonePixel(r, g, b, s);
      const expected = new Uint8ClampedArray([er * 255, eg * 255, eb * 255]);
      assert.equal(out[p * 4], expected[0]);
      assert.equal(out[p * 4 + 1], expected[1]);
      assert.equal(out[p * 4 + 2], expected[2]);
      assert.equal(out[p * 4 + 3], 255);
    }
  }
});

test("toneMapRows writes 16-bit output into a Uint16Array", () => {
  const width = 2;
  const height = 2;
  const data = new Uint16Array([
    0, 0, 0, 65535, 65535, 65535, 11796, 23593, 35389, 6553, 6553, 6553,
  ]);
  const image = { data, width, height, colors: 3, bits: 16 };
  const s = settings({ vibrance: 0.5, saturation: -0.3 });
  const out = new Uint16Array(width * height * 4);
  toneMapRows(image, s, out, 0, height);
  for (let p = 0; p < 4; p++) {
    const r = data[p * 3] / 65535;
    const g = data[p * 3 + 1] / 65535;
    const b = data[p * 3 + 2] / 65535;
    const [er, eg, eb] = applyTonePixel(r, g, b, s);
    assert.equal(out[p * 4], Math.round(er * 65535));
    assert.equal(out[p * 4 + 1], Math.round(eg * 65535));
    assert.equal(out[p * 4 + 2], Math.round(eb * 65535));
    assert.equal(out[p * 4 + 3], 65535);
  }
});

// --- EFFECTS: invert / grain / chromatic noise (display post-step) -------

test("display effects: identity at ZERO_SETTINGS for any pixel/position", () => {
  for (const u of [0, 0.31, 0.5, 0.87, 1]) {
    for (const v of [0, 0.42, 1]) {
      for (const px of [
        [0, 0, 0],
        [0.18, 0.5, 0.9],
        [1, 1, 1],
      ]) {
        const out = applyDisplayEffects(
          px[0],
          px[1],
          px[2],
          ZERO_SETTINGS,
          u,
          v,
          1000,
          667,
        );
        assert.deepEqual(out, px, `u=${u} v=${v} px=${px}`);
      }
    }
  }
});

test("invert: photo negative is 1 - display on every channel", () => {
  const s = settings({ invert: 1 });
  for (const px of [
    [0, 0, 0],
    [0.2, 0.6, 0.9],
    [1, 1, 1],
  ]) {
    const out = applyDisplayEffects(px[0], px[1], px[2], s, 0.5, 0.5, 100, 100);
    assert.ok(Math.abs(out[0] - (1 - px[0])) < EPS);
    assert.ok(Math.abs(out[1] - (1 - px[1])) < EPS);
    assert.ok(Math.abs(out[2] - (1 - px[2])) < EPS);
  }
});

test("invert composes through toneMapRows (both encode paths)", () => {
  const width = 2;
  const height = 1;
  const data = new Uint16Array([13107, 26214, 39321, 52428, 6553, 19660]);
  const image = { data, width, height, colors: 3, bits: 16 };
  // plain encode path and the grading path both get inverted at the end
  for (const extra of [{}, { gradeShadowSat: 1, gradeShadowHue: 0 }]) {
    const base = settings(extra);
    const inv = settings({ ...extra, invert: 1 });
    const outBase = new Uint8ClampedArray(width * height * 4);
    const outInv = new Uint8ClampedArray(width * height * 4);
    toneMapRows(image, base, outBase, 0, height);
    toneMapRows(image, inv, outInv, 0, height);
    for (let p = 0; p < width; p++) {
      for (let c = 0; c < 3; c++) {
        // 255 - base (Uint8Clamped rounds both); allow ±1 for rounding
        assert.ok(
          Math.abs(outInv[p * 4 + c] - (255 - outBase[p * 4 + c])) <= 1,
          `extra=${JSON.stringify(extra)} px${p} ch${c}`,
        );
      }
      assert.equal(outInv[p * 4 + 3], 255);
    }
  }
});

test("grain: zero amount is identity, nonzero perturbs but stays in [0,1]", () => {
  const off = applyDisplayEffects(
    0.5,
    0.5,
    0.5,
    ZERO_SETTINGS,
    0.3,
    0.3,
    99,
    99,
  );
  assert.deepEqual(off, [0.5, 0.5, 0.5]);
  const on = settings({ grainAmount: 1 });
  let moved = false;
  for (let i = 0; i < 50; i++) {
    const out = applyDisplayEffects(0.5, 0.5, 0.5, on, i / 50, 0.5, 1000, 1000);
    for (const ch of out) assert.ok(ch >= 0 && ch <= 1);
    // monochromatic: all three channels shift by the same amount
    assert.ok(
      Math.abs(out[0] - out[1]) < EPS && Math.abs(out[1] - out[2]) < EPS,
    );
    if (Math.abs(out[0] - 0.5) > 1e-4) moved = true;
  }
  assert.ok(moved, "grain must perturb some positions");
});

test("grain: midtone bias suppresses grain at black & white (paper response)", () => {
  const s = settings({ grainAmount: 1 }); // grainMidtones defaults to mb=100
  let mid = 0;
  let extreme = 0;
  for (let i = 0; i < 60; i++) {
    const u = i / 60;
    for (const v of [0.25, 0.5, 0.75]) {
      mid = Math.max(
        mid,
        Math.abs(
          applyDisplayEffects(0.5, 0.5, 0.5, s, u, v, 800, 600)[0] - 0.5,
        ),
      );
      extreme = Math.max(
        extreme,
        Math.abs(applyDisplayEffects(0, 0, 0, s, u, v, 800, 600)[0]),
        Math.abs(applyDisplayEffects(1, 1, 1, s, u, v, 800, 600)[0] - 1),
      );
    }
  }
  // darktable's paper-response curve concentrates grain in the midtones and
  // nearly eliminates it at the toe and shoulder — not a hard window (so not
  // exactly zero), but orders of magnitude down
  assert.ok(mid > 0.02, `grain visible in midtones (${mid})`);
  assert.ok(extreme < mid * 0.05, `extremes (${extreme}) << midtones (${mid})`);
});

test("grain: deterministic and resolution-independent (preview == export)", () => {
  // same frame-normalized coordinate must yield the same grain regardless
  // of resolution — the preview/export parity guarantee
  const s = settings({ grainAmount: 0.8, grainSize: 0.2, grainMidtones: 0.5 });
  for (const u of [0.12, 0.5, 0.83]) {
    for (const v of [0.2, 0.77]) {
      const a = applyDisplayEffects(0.5, 0.5, 0.5, s, u, v, 600, 400);
      const b = applyDisplayEffects(0.5, 0.5, 0.5, s, u, v, 600, 400);
      assert.deepEqual(a, b, "must be deterministic");
      // aspect-matched larger frame, same aspect ratio, same normalized
      // coords → identical grain value
      const big = applyDisplayEffects(0.5, 0.5, 0.5, s, u, v, 6000, 4000);
      assert.deepEqual(a, big, `scale-invariant at u=${u} v=${v}`);
    }
  }
});

test("grain: size changes the cell scale (different grain field)", () => {
  const fine = settings({ grainAmount: 1, grainSize: -1 });
  const coarse = settings({ grainAmount: 1, grainSize: 1 });
  let differ = 0;
  for (let i = 0; i < 64; i++) {
    const u = i / 64;
    const f = applyDisplayEffects(0.5, 0.5, 0.5, fine, u, 0.5, 1000, 1000)[0];
    const c = applyDisplayEffects(0.5, 0.5, 0.5, coarse, u, 0.5, 1000, 1000)[0];
    if (Math.abs(f - c) > 1e-3) differ++;
  }
  assert.ok(differ > 10, "fine vs coarse grain fields must diverge");
});

test("noise: positive is chromatic (channels differ), negative adds nothing here", () => {
  // positive: independent per-channel perturbation
  const pos = settings({ noise: 1 });
  let chromatic = false;
  for (let i = 0; i < 40; i++) {
    const out = applyDisplayEffects(0.5, 0.5, 0.5, pos, i / 40, 0.5, 800, 800);
    for (const ch of out) assert.ok(ch >= 0 && ch <= 1);
    if (Math.abs(out[0] - out[1]) > 1e-4 || Math.abs(out[1] - out[2]) > 1e-4) {
      chromatic = true;
    }
  }
  assert.ok(chromatic, "positive noise must vary per channel");
  // negative noise is denoise (a prepass) — the display post-step is a no-op
  const neg = settings({ noise: -1 });
  for (let i = 0; i < 20; i++) {
    const out = applyDisplayEffects(0.4, 0.5, 0.6, neg, i / 20, 0.3, 800, 800);
    assert.deepEqual(out, [0.4, 0.5, 0.6], "negative noise must not add here");
  }
});

test("grain: midtone perturbation stays bounded (grain-unit clamp)", () => {
  // the grain unit is clamped to ±0.5 before the paper response, so even at
  // full Amount the delta at a midtone can't exceed ~0.39 (paper_resp(1)−0.5)
  const s = settings({ grainAmount: 1 });
  for (let i = 0; i < 100; i++) {
    const out = applyDisplayEffects(0.5, 0.5, 0.5, s, i / 100, 0.5, 500, 500);
    assert.ok(out[0] >= 0 && out[0] <= 1);
    assert.ok(Math.abs(out[0] - 0.5) <= 0.39, `unbounded grain: ${out[0]}`);
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
