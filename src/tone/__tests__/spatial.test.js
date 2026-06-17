import { test } from "node:test";
import assert from "node:assert/strict";
import { SPATIAL, NR } from "../constants.js";
import {
  atrousPass,
  gaussianBlur,
  computeDetailPlanes,
  computeSharpenDeltaPlane,
  computeLightBalanceWeightPlane,
  computeDeltaPlane,
  textureDelta,
  clarityDelta,
  nrDelta,
  presenceRatio,
  sharpenRatio,
  lightBalanceGain,
  dehazeTransmission,
  computeDehazeAux,
  downsampleRgbFromImage,
  computeDehazePlane,
  lumaFromImage,
  applyPresencePrepass,
} from "../spatial.js";
import { ZERO_SETTINGS } from "../tone-math.js";
import { createBrushMask } from "../mask-math.js";

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

test("gaussianBlur leaves a flat plane unchanged", () => {
  const w = 16;
  const h = 12;
  const src = new Float32Array(w * h).fill(0.37);
  const dst = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  gaussianBlur(src, dst, tmp, w, h, {
    kernel: new Float32Array([0.25, 0.5, 0.25]),
    radius: 1,
  });
  for (let i = 0; i < dst.length; i++) {
    assert.ok(Math.abs(dst[i] - 0.37) < EPS, `pixel ${i}`);
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

test("nrDelta: zero amount is identity, soft-threshold cores small detail", () => {
  assert.equal(nrDelta(0.5, 0), 0); // no NR
  // detail below the noise floor is fully removed (added delta = -d1)
  const small = NR.THRESH * 0.4;
  assert.ok(Math.abs(nrDelta(small, 1) + small) < EPS, "flats smoothed");
  assert.ok(Math.abs(nrDelta(-small, 1) - small) < EPS);
  // a large edge keeps most of its amplitude: shrink is d - THRESH, so the
  // delta only subtracts the floor, never flips the sign
  const edge = 0.4;
  const cored = edge + nrDelta(edge, 1); // = shrunk value
  assert.ok(Math.abs(cored - (edge - NR.THRESH)) < EPS, "edge survives");
  assert.ok(cored > 0, "edge keeps its sign");
});

test("nrDelta: amount interpolates between original and fully cored", () => {
  const d = NR.THRESH * 0.5; // below the floor → fully cored is 0
  assert.ok(Math.abs(nrDelta(d, 1) + d) < EPS); // amount 1 → removes it all
  assert.ok(Math.abs(nrDelta(d, 0.5) + d * 0.5) < EPS); // halfway
});

test("presenceRatio: identity at zero delta, capped at RATIO_MAX", () => {
  assert.equal(presenceRatio(0.18, 0), 1);
  assert.ok(presenceRatio(0.18, 0.1) > 1);
  assert.ok(presenceRatio(0.18, -0.1) < 1);
  assert.ok(presenceRatio(1e-7, 1) <= SPATIAL.RATIO_MAX);
});

test("sharpenRatio: amount blends a linear luma delta and caps gain", () => {
  assert.equal(sharpenRatio(0.18, 0.2, 0), 1);
  assert.ok(sharpenRatio(0.18, 0.2, 0.5) > 1);
  assert.ok(sharpenRatio(0.18, -0.1, 1) < 1);
  assert.ok(sharpenRatio(1e-7, 1, 1) <= SPATIAL.RATIO_MAX);
});

test("dehazeTransmission: identity at zero, floored, haze re-add above 1", () => {
  assert.equal(dehazeTransmission(0.5, 0), 1);
  assert.equal(
    dehazeTransmission(1, 1),
    Math.max(1 - SPATIAL.DEHAZE_OMEGA, SPATIAL.DEHAZE_T_MIN),
  );
  assert.ok(dehazeTransmission(1, -1) > 1);
});

test("lightBalanceGain is signed and shadow-weighted", () => {
  assert.equal(lightBalanceGain(1, 0), 1);
  assert.ok(lightBalanceGain(1, 1) > lightBalanceGain(0.25, 1));
  assert.ok(lightBalanceGain(1, -1) < lightBalanceGain(0.25, -1));
  assert.ok(lightBalanceGain(0.25, 1) > 1);
  assert.ok(lightBalanceGain(0.25, -1) < 1);
});

test("computeLightBalanceWeightPlane weights shadows above highlights", () => {
  const w = 64;
  const h = 8;
  const luma = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      luma[y * w + x] = x < w / 2 ? 0.02 : 0.9;
    }
  }
  const weights = computeLightBalanceWeightPlane(luma, w, h);
  const dark = weights[Math.floor(h / 2) * w + 8];
  const bright = weights[Math.floor(h / 2) * w + w - 9];
  assert.ok(dark > bright + 0.3, `${dark} <= ${bright}`);
  for (const v of weights) assert.ok(v >= 0.25 && v <= 1);
});

test("applyPresencePrepass applies Light Balance as an RGB ratio", () => {
  const img = grayImage(8, 2, (x) => (x < 4 ? 0.04 : 0.8));
  const before = img.data.slice();
  applyPresencePrepass(img, { ...ZERO_SETTINGS, lightBalance: 1 }, 1);
  const dark = img.data[0] / before[0];
  const bright = img.data[7 * 3] / before[7 * 3];
  assert.ok(dark > bright, `${dark} <= ${bright}`);
  assert.ok(dark > 1);
  assert.ok(bright > 1);
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

test("computeSharpenDeltaPlane leaves flat luma unchanged", () => {
  const w = 24;
  const h = 16;
  const luma = new Float32Array(w * h).fill(0.42);
  const delta = computeSharpenDeltaPlane(luma, w, h);
  for (let i = 0; i < delta.length; i++) {
    assert.ok(Math.abs(delta[i]) < 1e-5, `pixel ${i}`);
  }
});

test("computeSharpenDeltaPlane concentrates a blurred point", () => {
  const w = 33;
  const h = 33;
  const cx = 16;
  const cy = 16;
  const sigma = 1.4;
  const luma = new Float32Array(w * h);
  let peakNeighbor = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const v = 0.7 * Math.exp(-d2 / (2 * sigma * sigma));
      luma[y * w + x] = v;
      if (Math.abs(x - cx) + Math.abs(y - cy) === 1) {
        peakNeighbor = Math.max(peakNeighbor, v);
      }
    }
  }
  const delta = computeSharpenDeltaPlane(luma, w, h);
  const center = cy * w + cx;
  assert.ok(delta[center] > 0, "center must sharpen upward");
  assert.ok(
    luma[center] + delta[center] > peakNeighbor,
    "deconvolved center must stand above its blurred neighbors",
  );
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

test("applyPresencePrepass: full mask local texture matches global texture", () => {
  const make = () => grayImage(32, 24, (x, y) => 0.4 + 0.1 * rand(y * 32 + x));
  const global = make();
  applyPresencePrepass(global, { ...ZERO_SETTINGS, texture: 1 }, 1);

  const mask = createBrushMask(32, 24);
  mask.coverage.fill(255);
  mask.adjustments = { ...mask.adjustments, texture: 1 };
  const local = make();
  applyPresencePrepass(local, { ...ZERO_SETTINGS, masks: [mask] }, 1);

  assert.deepEqual(local.data, global.data);
});

test("applyPresencePrepass: sharpening increases local contrast", () => {
  /** @param {Uint16Array} data */
  function variance(data) {
    let mean = 0;
    for (let i = 0; i < data.length; i += 3) mean += data[i];
    mean /= data.length / 3;
    let v = 0;
    for (let i = 0; i < data.length; i += 3) v += (data[i] - mean) ** 2;
    return v / (data.length / 3);
  }
  const make = () =>
    grayImage(32, 24, (x, y) => 0.35 + 0.2 * Math.sin(x / 4) * Math.sin(y / 4));
  const base = variance(make().data);
  const sharpened = make();
  applyPresencePrepass(sharpened, { ...ZERO_SETTINGS, sharpening: 1 }, 1);
  assert.ok(variance(sharpened.data) > base, "RL must add local contrast");
});

test("applyPresencePrepass: negative noise (denoise) smooths a noisy flat", () => {
  /** local high-frequency variance: mean squared finest-band detail */
  function fineVar(/** @type {Uint16Array} */ data, w, h) {
    let s = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const a = data[(y * w + x) * 3];
        const b = data[(y * w + x - 1) * 3];
        s += (a - b) ** 2;
        n++;
      }
    }
    return s / n;
  }
  // a mid-gray flat with fine pixel noise (the denoise target)
  const make = () =>
    grayImage(48, 32, (x, y) => 0.45 + 0.03 * (rand(y * 48 + x) - 0.5) * 2);
  const before = fineVar(make().data, 48, 32);
  const img = make();
  applyPresencePrepass(img, { ...ZERO_SETTINGS, noise: -1 }, 1);
  const after = fineVar(img.data, 48, 32);
  assert.ok(
    after < before,
    `denoise must reduce fine variance (${before}->${after})`,
  );
});

test("applyPresencePrepass: negative noise preserves an edge", () => {
  // a hard vertical edge: denoise must not flatten it (coring keeps edges)
  const img = grayImage(32, 24, (x) => (x < 16 ? 0.2 : 0.8));
  applyPresencePrepass(img, { ...ZERO_SETTINGS, noise: -1 }, 1);
  const mid = 12 * 32;
  const lo = img.data[(mid + 4) * 3] / 65535;
  const hi = img.data[(mid + 27) * 3] / 65535;
  assert.ok(hi - lo > 0.45, `edge contrast must survive (${lo} vs ${hi})`);
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
