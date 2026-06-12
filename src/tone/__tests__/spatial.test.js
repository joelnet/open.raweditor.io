import { test } from "node:test";
import assert from "node:assert/strict";
import { SPATIAL } from "../constants.js";
import {
  atrousPass,
  computeDetailPlanes,
  computeDeltaPlane,
  textureDelta,
  clarityDelta,
  presenceRatio,
  dehazeTransmission,
  computeDehazeAux,
  downsampleRgbFromImage,
  computeDehazePlane,
  lumaFromImage,
  applyPresencePrepass,
} from "../spatial.js";
import { ZERO_SETTINGS } from "../tone-math.js";

const EPS = 1e-6;

/** Deterministic pseudo-random in [0, 1). @param {number} i */
function rand(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Gray 16-bit 3-channel image from a [0,1] luminance function.
 * @param {number} w @param {number} h
 * @param {(x: number, y: number) => number} fn */
function grayImage(w, h, fn) {
  const data = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(fn(x, y) * 65535);
      const p = (y * w + x) * 3;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
    }
  }
  return { data, width: w, height: h, colors: 3, bits: 16 };
}

test("atrousPass leaves a flat plane unchanged", () => {
  const w = 16;
  const h = 12;
  const src = new Float32Array(w * h).fill(0.42);
  const dst = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  for (const step of [1, 2, 7]) {
    atrousPass(src, dst, tmp, w, h, step);
    for (let i = 0; i < dst.length; i++) {
      assert.ok(Math.abs(dst[i] - 0.42) < EPS, `step ${step}, i ${i}`);
    }
  }
});

test("textureDelta: zero slider is identity, threshold gates the boost", () => {
  assert.equal(textureDelta(0.05, 0, 0), 0);
  assert.equal(textureDelta(0.001, 0, 1), 0); // below band-0 noise floor
  assert.ok(textureDelta(0.05, 0, 1) > 0);
  assert.ok(textureDelta(-0.05, 0, 1) < 0); // boost follows the detail sign
});

test("textureDelta: negative slider attenuates, floored at MIN_GAIN", () => {
  const d = 0.05;
  // at slider -1 with band weight 1 the gain clamps to TEXTURE_MIN_GAIN
  const out = textureDelta(d, 1, -1);
  assert.ok(Math.abs(out - (SPATIAL.TEXTURE_MIN_GAIN - 1) * d) < EPS);
  // never overshoots past removing the band entirely
  assert.ok(d + textureDelta(d, 1, -1) >= SPATIAL.TEXTURE_MIN_GAIN * d - EPS);
});

test("clarityDelta: rolloff starves large edges of gain", () => {
  assert.equal(clarityDelta(0.2, 0.5, 0), 0);
  const small = clarityDelta(0.2, 0.5, 1);
  const large = clarityDelta(1, 0.5, 1);
  assert.ok(small > 0);
  assert.ok(Math.abs(large) < Math.abs(small)); // halo killer
});

test("presenceRatio: identity at zero delta, capped at RATIO_MAX", () => {
  assert.equal(presenceRatio(0.18, 0), 1);
  assert.ok(presenceRatio(0.18, 0.1) > 1);
  assert.ok(presenceRatio(0.18, -0.1) < 1);
  assert.ok(presenceRatio(1e-7, 1) <= SPATIAL.RATIO_MAX);
});

test("dehazeTransmission: identity at zero, floored, haze re-add above 1", () => {
  assert.equal(dehazeTransmission(0.5, 0), 1);
  assert.equal(
    dehazeTransmission(1, 1),
    Math.max(1 - SPATIAL.DEHAZE_OMEGA, SPATIAL.DEHAZE_T_MIN),
  );
  assert.ok(dehazeTransmission(1, -1) > 1);
});

test("computeDeltaPlane matches per-pixel evaluation of the detail planes", () => {
  // the drift guard: the export path's fused accumulation must equal what
  // the shader computes from the preview's detail planes
  const w = 24;
  const h = 16;
  const luma = new Float32Array(w * h);
  for (let i = 0; i < luma.length; i++) luma[i] = 0.1 + 0.8 * rand(i);
  const texture = 0.5;
  const clarity = -0.3;
  const delta = computeDeltaPlane(luma, w, h, 1, texture, clarity);
  const { c1, c2, c3, base } = computeDetailPlanes(luma, w, h);
  for (let i = 0; i < luma.length; i++) {
    const y0 = Math.pow(luma[i], 1 / SPATIAL.GAMMA);
    const expected =
      textureDelta(y0 - c1[i], 0, texture) +
      textureDelta(c1[i] - c2[i], 1, texture) +
      textureDelta(c2[i] - c3[i], 2, texture) +
      clarityDelta(y0 - base[i], y0, clarity);
    assert.ok(Math.abs(delta[i] - expected) < 1e-5, `pixel ${i}`);
  }
});

test("dehaze plane stays in [0, 1] and tracks haze density", () => {
  // bright flat sky (hazy) over a dark textured ground
  const img = grayImage(64, 48, (x, y) =>
    y < 24 ? 0.92 : 0.15 + 0.1 * rand(y * 64 + x),
  );
  const aux = computeDehazeAux(downsampleRgbFromImage(img));
  const plane = computeDehazePlane(aux, lumaFromImage(img), 64, 48);
  let skyD = 0;
  let groundD = 0;
  for (let x = 0; x < 64; x++) {
    skyD += plane[8 * 64 + x];
    groundD += plane[40 * 64 + x];
  }
  for (const v of plane) assert.ok(v >= 0 && v <= 1);
  assert.ok(skyD > groundD, "sky must read hazier than the dark ground");
});

test("applyPresencePrepass: all-zero sliders never touch the data", () => {
  const img = grayImage(32, 24, (x, y) => rand(y * 32 + x));
  const before = Uint16Array.from(img.data);
  applyPresencePrepass(img, { ...ZERO_SETTINGS }, 1);
  assert.deepEqual(img.data, before);
});

test("applyPresencePrepass: positive texture adds local contrast, negative removes it", () => {
  /** @param {Uint16Array} data */
  function variance(data) {
    let mean = 0;
    for (let i = 0; i < data.length; i += 3) mean += data[i];
    mean /= data.length / 3;
    let v = 0;
    for (let i = 0; i < data.length; i += 3) v += (data[i] - mean) ** 2;
    return v / (data.length / 3);
  }
  const make = () => grayImage(32, 24, (x, y) => 0.4 + 0.1 * rand(y * 32 + x));
  const base = variance(make().data);

  const boosted = make();
  applyPresencePrepass(boosted, { ...ZERO_SETTINGS, texture: 1 }, 1);
  assert.ok(variance(boosted.data) > base, "texture +1 must amplify detail");

  const smoothed = make();
  applyPresencePrepass(smoothed, { ...ZERO_SETTINGS, texture: -1 }, 1);
  assert.ok(variance(smoothed.data) < base, "texture -1 must smooth detail");
});

test("applyPresencePrepass: dehaze recovers dark objects under synthetic haze", () => {
  // haze model I = J·t + A·(1 - t) with A = 0.95, t = 0.55; sky stays at
  // the airlight, the ground holds dark structures
  const A = 0.95;
  const t = 0.55;
  const img = grayImage(64, 48, (x, y) => {
    const j = y < 16 ? A : x % 8 < 4 ? 0.05 : 0.3;
    return j * t + A * (1 - t);
  });
  const dark = (40 * 64 + 2) * 3; // a J=0.05 ground pixel
  const before = img.data[dark];
  applyPresencePrepass(img, { ...ZERO_SETTINGS, dehaze: 1 }, 1);
  assert.ok(
    img.data[dark] < before * 0.7,
    `dehaze must darken hazy shadows (${before} -> ${img.data[dark]})`,
  );
});

test("applyPresencePrepass: negative dehaze adds haze (lifts shadows)", () => {
  const img = grayImage(64, 48, (x, y) =>
    y < 16 ? 0.9 : x % 8 < 4 ? 0.05 : 0.3,
  );
  const dark = (40 * 64 + 2) * 3;
  const before = img.data[dark];
  applyPresencePrepass(img, { ...ZERO_SETTINGS, dehaze: -1 }, 1);
  assert.ok(img.data[dark] > before, "haze re-add must lift dark pixels");
});
