// Spatial analysis + application for the presence sliders (sharpening,
// texture, clarity, dehaze). Unlike the per-pixel tone pipeline, these need
// neighborhood information — but every intermediate here depends only on
// the source image, never on slider values, so the preview computes them
// once per opened file (spatial-worker.js → renderer aux textures) and the
// shader stays single-pass and realtime. The export recomputes the same
// planes at full resolution and folds the result into the linear data
// before toneMapRows (applyPresencePrepass), so both paths share this one
// implementation of the math. The per-pixel formulas (textureDelta,
// clarityDelta, dehazeTransmission, presence ratio) are mirrored in the
// fragment shader with constants interpolated from constants.js — keep
// them in sync the same way tone-math.js and shaders.js are.
//
// Algorithms (see SPATIAL in constants.js for the provenance):
//   sharpening — Richardson-Lucy deconvolution with a Gaussian PSF
//   texture    — à trous B3-spline wavelet band gains with a noise floor
//   clarity    — base-band local contrast with d·exp(-k·d²) halo rolloff
//   dehaze     — dark channel prior + guided-filter transmission refinement

import { LUMA, SPATIAL, NR } from "./constants.js";
import { decodeInput, encodeInput } from "./tone-math.js";

// --- luminance planes -------------------------------------------------

/**
 * Linear-light Rec.709 luma plane from preview pixels (RGBA u16).
 * @param {Uint16Array} pixels
 * @param {number} width
 * @param {number} height
 */
export function lumaFromRgba16(pixels, width, height) {
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] =
      LUMA[0] * decodeInput(pixels[p] / 65535) +
      LUMA[1] * decodeInput(pixels[p + 1] / 65535) +
      LUMA[2] * decodeInput(pixels[p + 2] / 65535);
  }
  return out;
}

/**
 * Linear-light Rec.709 luma plane from a decoded LibRaw image.
 * @param {{ data: Uint16Array | Uint8Array, width: number, height: number,
 *           colors: number, bits: number }} image
 */
export function lumaFromImage(image) {
  const { data, width, height, colors, bits } = image;
  const maxVal = bits === 16 ? 65535 : 255;
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += colors) {
    out[i] =
      LUMA[0] * decodeInput(data[p] / maxVal) +
      LUMA[1] * decodeInput(data[p + 1] / maxVal) +
      LUMA[2] * decodeInput(data[p + 2] / maxVal);
  }
  return out;
}

/** @param {Float32Array} luma linear → new gamma-encoded plane */
function gammaPlane(luma) {
  const out = new Float32Array(luma.length);
  const inv = 1 / SPATIAL.GAMMA;
  for (let i = 0; i < luma.length; i++) {
    out[i] = Math.pow(Math.max(luma[i], 0), inv);
  }
  return out;
}

// --- à trous wavelet blur ----------------------------------------------

/**
 * One separable à trous pass: B3-spline kernel (1,4,6,4,1)/16 with taps
 * `step` pixels apart, clamp-to-edge. src and dst must differ.
 * @param {Float32Array} src
 * @param {Float32Array} dst
 * @param {Float32Array} tmp scratch, same length
 * @param {number} w @param {number} h @param {number} step
 */
export function atrousPass(src, dst, tmp, w, h, step) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(x - step, 0);
      const x2 = Math.min(x + step, w - 1);
      const x0 = Math.max(x - 2 * step, 0);
      const x3 = Math.min(x + 2 * step, w - 1);
      tmp[row + x] =
        (src[row + x0] +
          4 * src[row + x1] +
          6 * src[row + x] +
          4 * src[row + x2] +
          src[row + x3]) /
        16;
    }
  }
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(y - step, 0) * w;
    const y2 = Math.min(y + step, h - 1) * w;
    const y0 = Math.max(y - 2 * step, 0) * w;
    const y3 = Math.min(y + 2 * step, h - 1) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      dst[row + x] =
        (tmp[y0 + x] +
          4 * tmp[y1 + x] +
          6 * tmp[row + x] +
          4 * tmp[y2 + x] +
          tmp[y3 + x]) /
        16;
    }
  }
}

// --- Gaussian Richardson-Lucy deconvolution -----------------------------

/** @param {number} sigma */
function gaussianKernel(sigma) {
  const s = Math.max(sigma, 0.01);
  const radius = Math.max(1, Math.ceil(s * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * s * s));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return { kernel, radius };
}

/**
 * Separable Gaussian blur with clamp-to-edge borders.
 * @param {Float32Array} src
 * @param {Float32Array} dst
 * @param {Float32Array} tmp
 * @param {number} w @param {number} h
 * @param {{ kernel: Float32Array, radius: number }} g
 */
export function gaussianBlur(src, dst, tmp, w, h, g) {
  const { kernel, radius } = g;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(Math.max(x + k, 0), w - 1);
        sum += src[row + xx] * kernel[k + radius];
      }
      tmp[row + x] = sum;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(Math.max(y + k, 0), h - 1);
        sum += tmp[yy * w + x] * kernel[k + radius];
      }
      dst[row + x] = sum;
    }
  }
}

/**
 * Slider-independent Richardson-Lucy sharpening plane on linear luminance.
 * Uses the classic update also used by G'MIC:
 *   estimate *= H( observed / max(H(estimate), eps) )
 * where H is a symmetric Gaussian point-spread function.
 * @param {Float32Array} luma linear-light luma plane
 * @param {number} w @param {number} h
 * @param {number} [scale] full-res / preview scale
 * @returns {Float32Array} linear-luma delta: deconvolved - source
 */
export function computeSharpenDeltaPlane(luma, w, h, scale = 1) {
  const n = w * h;
  const estimate = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    estimate[i] = Math.max(luma[i], 0);
  }
  const blurred = new Float32Array(n);
  const ratio = new Float32Array(n);
  const correction = new Float32Array(n);
  const tmp = new Float32Array(n);
  const g = gaussianKernel(SPATIAL.SHARPEN_RADIUS * Math.max(scale, 1));
  for (let iter = 0; iter < SPATIAL.SHARPEN_ITERATIONS; iter++) {
    gaussianBlur(estimate, blurred, tmp, w, h, g);
    for (let i = 0; i < n; i++) {
      ratio[i] =
        Math.max(luma[i], 0) / Math.max(blurred[i], SPATIAL.SHARPEN_EPS);
    }
    gaussianBlur(ratio, correction, tmp, w, h, g);
    for (let i = 0; i < n; i++) {
      estimate[i] = Math.max(estimate[i] * correction[i], 0);
    }
  }
  for (let i = 0; i < n; i++) {
    estimate[i] -= Math.max(luma[i], 0);
  }
  return estimate;
}

/**
 * Slider-independent detail planes for the GPU preview: à trous levels
 * c1–c3 (texture bands are the differences between consecutive levels)
 * and the level-DETAIL_LEVELS residual (clarity base), all on
 * gamma-encoded luminance. `scale` stretches the level steps so a
 * full-resolution image gets the same physical frequency bands as its
 * preview (RawTherapee's scale handling).
 * @param {Float32Array} luma linear-light luma plane
 * @param {number} w @param {number} h
 * @param {number} [scale] integer ≥ 1
 * @returns {{ c1: Float32Array, c2: Float32Array, c3: Float32Array,
 *             base: Float32Array }}
 */
export function computeDetailPlanes(luma, w, h, scale = 1) {
  const tmp = new Float32Array(w * h);
  /** @type {Float32Array[]} */
  const levels = [];
  let cur = gammaPlane(luma);
  for (let j = 0; j < SPATIAL.DETAIL_LEVELS; j++) {
    const dst = new Float32Array(w * h);
    atrousPass(cur, dst, tmp, w, h, scale * (1 << j));
    levels.push(dst);
    cur = dst;
  }
  return { c1: levels[0], c2: levels[1], c3: levels[2], base: cur };
}

// --- per-pixel presence formulas (mirrored in gl/shaders.js) ------------

/**
 * Texture boost for one à trous band's detail coefficient. Positive
 * sliders amplify only what exceeds the band's noise floor; negative
 * sliders attenuate the whole band (smoothing should hit noise too),
 * floored so edges never fully dissolve.
 * @param {number} d band detail (gamma units)
 * @param {number} band 0 = finest
 * @param {number} s texture slider [-1, 1]
 */
export function textureDelta(d, band, s) {
  const w = SPATIAL.TEXTURE_WEIGHTS[band];
  if (s >= 0) {
    const t = SPATIAL.TEXTURE_THRESH[band];
    return (
      s * SPATIAL.TEXTURE_GAIN * w * Math.sign(d) * Math.max(Math.abs(d) - t, 0)
    );
  }
  return (Math.max(1 + s * w, SPATIAL.TEXTURE_MIN_GAIN) - 1) * d;
}

/**
 * Noise-reduction delta for the FINEST à trous band (negative NOISE
 * slider): edge-preserving soft-threshold (coring). Detail coefficients
 * below the noise floor are pulled toward zero (smoothing flats), while
 * larger ones — edges — keep their amplitude minus the floor, so structure
 * survives. The returned value is what to ADD to the gamma-luma so that the
 * finest band is replaced by its shrunk version: shrink(d1) − d1, scaled by
 * the slider magnitude. This is the wavelet-shrinkage recipe behind
 * darktable denoise / RawTherapee wavelet NR, applied to only the finest
 * band (distinct from negative Texture's whole-band attenuation).
 * @param {number} d1 finest-band detail y0 − c1 (gamma units)
 * @param {number} amount NR strength [0, 1] (|negative slider|)
 */
export function nrDelta(d1, amount) {
  if (amount <= 0) return 0;
  const tau = NR.THRESH;
  const a = Math.abs(d1);
  // soft threshold: |d| ≤ τ → 0, else sign(d)·(|d| − τ)
  const shrunk = a <= tau ? 0 : Math.sign(d1) * (a - tau);
  // amount interpolates between the original band (0) and the cored band (1)
  return amount * (shrunk - d1);
}

/**
 * Clarity boost for the base-band detail. The exp rolloff starves large
 * edges (the halo generators) of gain; the midtone parabola keeps the
 * endpoints from clipping.
 * @param {number} d base-band detail (gamma units)
 * @param {number} y0 gamma luminance [0, 1]
 * @param {number} s clarity slider [-1, 1]
 */
export function clarityDelta(d, y0, s) {
  const mid = Math.min(Math.max(4 * y0 * (1 - y0), 0), 1);
  return (
    s *
    SPATIAL.CLARITY_GAIN *
    mid *
    d *
    Math.exp(-SPATIAL.CLARITY_ROLLOFF * d * d)
  );
}

/**
 * Linear-light gain that applies a gamma-domain luminance delta as a
 * hue-preserving RGB ratio.
 * @param {number} yLin linear source luma
 * @param {number} delta gamma-domain luminance boost
 */
export function presenceRatio(yLin, delta) {
  if (delta === 0) return 1;
  const y0 = Math.pow(Math.max(yLin, 0), 1 / SPATIAL.GAMMA);
  const yNew = Math.max(y0 + delta, 0);
  return Math.min(
    Math.pow(yNew, SPATIAL.GAMMA) / Math.max(yLin, 1e-5),
    SPATIAL.RATIO_MAX,
  );
}

/**
 * Linear-light gain that blends a precomputed Richardson-Lucy luma delta.
 * `amount` is the UI blend factor, matching RawTherapee's Amount semantics.
 * @param {number} yLin linear source luma
 * @param {number} delta linear-luma deconvolution delta
 * @param {number} amount sharpening amount [0, 1]
 */
export function sharpenRatio(yLin, delta, amount) {
  if (amount <= 0 || delta === 0) return 1;
  const yNew = Math.max(yLin + amount * delta, 0);
  return Math.min(yNew / Math.max(yLin, 1e-5), SPATIAL.RATIO_MAX);
}

/**
 * Transmission at one pixel from the refined haze amount D. Positive
 * sliders remove haze (t < 1 → recovery amplifies); negative sliders add
 * it (t > 1 compresses toward the airlight, darktable's freebie).
 * @param {number} D refined dark channel [0, 1]
 * @param {number} s dehaze slider [-1, 1]
 */
export function dehazeTransmission(D, s) {
  return Math.max(1 - SPATIAL.DEHAZE_OMEGA * s * D, SPATIAL.DEHAZE_T_MIN);
}

/**
 * ΔY' plane for fixed slider values — the export-path equivalent of the
 * shader evaluating textureDelta/clarityDelta/nrDelta against the detail
 * planes. Accumulates during the decomposition so full-resolution images
 * never hold all the level planes at once. `nr` is the noise-reduction
 * amount (the magnitude of a negative NOISE slider); it cores the finest
 * band only.
 * @param {Float32Array} luma linear-light luma plane
 * @param {number} w @param {number} h
 * @param {number} scale integer ≥ 1
 * @param {number} texture slider [-1, 1]
 * @param {number} clarity slider [-1, 1]
 * @param {number} [nr] noise-reduction amount [0, 1]
 */
export function computeDeltaPlane(luma, w, h, scale, texture, clarity, nr = 0) {
  const n = w * h;
  const y0 = gammaPlane(luma);
  let cur = Float32Array.from(y0);
  let next = new Float32Array(n);
  const tmp = new Float32Array(n);
  const delta = new Float32Array(n);
  const levels = clarity !== 0 ? SPATIAL.DETAIL_LEVELS : SPATIAL.TEXTURE_BANDS;
  for (let j = 0; j < levels; j++) {
    atrousPass(cur, next, tmp, w, h, scale * (1 << j));
    if (j === 0 && nr > 0) {
      // finest band = y0 − c1 → soft-threshold coring (edge-preserving NR)
      for (let i = 0; i < n; i++) {
        delta[i] += nrDelta(cur[i] - next[i], nr);
      }
    }
    if (texture !== 0 && j < SPATIAL.TEXTURE_BANDS) {
      for (let i = 0; i < n; i++) {
        delta[i] += textureDelta(cur[i] - next[i], j, texture);
      }
    }
    [cur, next] = [next, cur];
  }
  if (clarity !== 0) {
    for (let i = 0; i < n; i++) {
      delta[i] += clarityDelta(y0[i] - cur[i], y0[i], clarity);
    }
  }
  return delta;
}

// --- dehaze analysis (dark channel prior, low resolution) ---------------

/**
 * Low-resolution linear RGB planes for the dehaze analysis.
 * @typedef {{ r: Float32Array, g: Float32Array, b: Float32Array,
 *             w: number, h: number }} LowResRgb
 */

/**
 * @param {(i: number, c: number) => number} sample linear value of
 *   channel c at source index i
 * @param {number} width @param {number} height source dims
 * @returns {LowResRgb}
 */
function downsampleRgb(sample, width, height) {
  const factor = Math.max(
    1,
    Math.ceil(Math.max(width, height) / SPATIAL.DEHAZE_MAX_EDGE),
  );
  const w = Math.ceil(width / factor);
  const h = Math.ceil(height / factor);
  const r = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let oy = 0; oy < h; oy++) {
    const y1 = Math.min((oy + 1) * factor, height);
    for (let ox = 0; ox < w; ox++) {
      const x1 = Math.min((ox + 1) * factor, width);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let count = 0;
      for (let y = oy * factor; y < y1; y++) {
        for (let x = ox * factor; x < x1; x++) {
          const i = y * width + x;
          sr += sample(i, 0);
          sg += sample(i, 1);
          sb += sample(i, 2);
          count++;
        }
      }
      const o = oy * w + ox;
      r[o] = sr / count;
      g[o] = sg / count;
      b[o] = sb / count;
    }
  }
  return { r, g, b, w, h };
}

/**
 * @param {Uint16Array} pixels RGBA u16 preview
 * @param {number} width @param {number} height
 * @returns {LowResRgb}
 */
export function downsampleRgbFromRgba16(pixels, width, height) {
  return downsampleRgb(
    (i, c) => decodeInput(pixels[i * 4 + c] / 65535),
    width,
    height,
  );
}

/**
 * @param {{ data: Uint16Array | Uint8Array, width: number, height: number,
 *           colors: number, bits: number }} image
 * @returns {LowResRgb}
 */
export function downsampleRgbFromImage(image) {
  const { data, width, height, colors, bits } = image;
  const maxVal = bits === 16 ? 65535 : 255;
  return downsampleRgb(
    (i, c) => decodeInput(data[i * colors + c] / maxVal),
    width,
    height,
  );
}

/**
 * Separable box mean with edge-clipped windows (exact counts).
 * @param {Float32Array} src @param {Float32Array} dst
 * @param {Float32Array} tmp @param {number} w @param {number} h
 * @param {number} r radius
 */
function boxBlur(src, dst, tmp, w, h, r) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r;
      const hi = x + r;
      tmp[row + x] = sum / (Math.min(hi, w - 1) - Math.max(lo, 0) + 1);
      if (hi + 1 <= w - 1) sum += src[row + hi + 1];
      if (lo >= 0) sum -= src[row + lo];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) sum += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = y - r;
      const hi = y + r;
      dst[y * w + x] = sum / (Math.min(hi, h - 1) - Math.max(lo, 0) + 1);
      if (hi + 1 <= h - 1) sum += tmp[(hi + 1) * w + x];
      if (lo >= 0) sum -= tmp[lo * w + x];
    }
  }
}

/**
 * Separable box min (the dark channel's patch minimum).
 * @param {Float32Array} src @param {Float32Array} dst
 * @param {Float32Array} tmp @param {number} w @param {number} h
 * @param {number} r radius
 */
function boxMin(src, dst, tmp, w, h, r) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      const hi = Math.min(x + r, w - 1);
      for (let k = Math.max(x - r, 0); k <= hi; k++) {
        if (src[row + k] < m) m = src[row + k];
      }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = Infinity;
      const hi = Math.min(y + r, h - 1);
      for (let k = Math.max(y - r, 0); k <= hi; k++) {
        if (tmp[k * w + x] < m) m = tmp[k * w + x];
      }
      dst[y * w + x] = m;
    }
  }
}

/**
 * Dehaze analysis result: guided-filter coefficient planes (low-res) plus
 * the estimated airlight. The refined haze amount at any resolution is
 * D(x) = a↑(x)·Y(x) + b↑(x) against that resolution's linear luma — the
 * fast-guided-filter joint upsampling, so the full-res transmission map is
 * edge-aware for free.
 * @typedef {{ a: Float32Array, b: Float32Array, w: number, h: number,
 *             airlight: [number, number, number] }} DehazeAux
 */

/**
 * Dark-channel-prior analysis on a low-res image (RT/darktable recipe).
 * @param {LowResRgb} low
 * @returns {DehazeAux}
 */
export function computeDehazeAux(low) {
  const { r, g, b, w, h } = low;
  const n = w * h;

  // Airlight: among the haziest pixels (top dark-channel quantile), average
  // the brightest quantile (darktable's 95/95 estimator).
  const dark0 = new Float32Array(n);
  for (let i = 0; i < n; i++) dark0[i] = Math.min(r[i], g[i], b[i]);
  const sorted = Float32Array.from(dark0).sort();
  const q = sorted[Math.floor(SPATIAL.DEHAZE_AIR_QUANTILE * (n - 1))];
  /** @type {number[]} */
  const hazy = [];
  for (let i = 0; i < n; i++) if (dark0[i] >= q) hazy.push(i);
  hazy.sort(
    (i, j) =>
      LUMA[0] * r[j] +
      LUMA[1] * g[j] +
      LUMA[2] * b[j] -
      (LUMA[0] * r[i] + LUMA[1] * g[i] + LUMA[2] * b[i]),
  );
  const top = Math.max(
    1,
    Math.floor((1 - SPATIAL.DEHAZE_AIR_QUANTILE) * hazy.length),
  );
  let ar = 0;
  let ag = 0;
  let ab = 0;
  for (let k = 0; k < top; k++) {
    ar += r[hazy[k]];
    ag += g[hazy[k]];
    ab += b[hazy[k]];
  }
  /** @type {[number, number, number]} */
  const airlight = [
    Math.max(ar / top, 0.01),
    Math.max(ag / top, 0.01),
    Math.max(ab / top, 0.01),
  ];

  // Raw haze amount: patch-min dark channel of the airlight-normalized
  // image (He et al.'s min over channels and a window).
  const darkN = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    darkN[i] = Math.min(
      Math.max(
        Math.min(r[i] / airlight[0], g[i] / airlight[1], b[i] / airlight[2]),
        0,
      ),
      1,
    );
  }
  const raw = new Float32Array(n);
  const tmp = new Float32Array(n);
  boxMin(darkN, raw, tmp, w, h, SPATIAL.DEHAZE_PATCH_RADIUS);

  // Guided filter (guide = linear luma): refine the blocky patch minimum
  // into an edge-aware map, kept as (a, b) for joint upsampling.
  const guide = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    guide[i] = LUMA[0] * r[i] + LUMA[1] * g[i] + LUMA[2] * b[i];
  }
  const gr = SPATIAL.DEHAZE_GF_RADIUS;
  const meanI = new Float32Array(n);
  const meanP = new Float32Array(n);
  const corrII = new Float32Array(n);
  const corrIP = new Float32Array(n);
  boxBlur(guide, meanI, tmp, w, h, gr);
  boxBlur(raw, meanP, tmp, w, h, gr);
  for (let i = 0; i < n; i++) corrII[i] = guide[i] * guide[i];
  boxBlur(corrII, corrII, tmp, w, h, gr);
  for (let i = 0; i < n; i++) corrIP[i] = guide[i] * raw[i];
  boxBlur(corrIP, corrIP, tmp, w, h, gr);
  const a = new Float32Array(n);
  const b2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = corrII[i] - meanI[i] * meanI[i];
    const covIP = corrIP[i] - meanI[i] * meanP[i];
    a[i] = covIP / (varI + SPATIAL.DEHAZE_GF_EPS);
    b2[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = new Float32Array(n);
  const meanB = new Float32Array(n);
  boxBlur(a, meanA, tmp, w, h, gr);
  boxBlur(b2, meanB, tmp, w, h, gr);

  return { a: meanA, b: meanB, w, h, airlight };
}

/**
 * Refined haze amount at one pixel: bilinear coefficient upsample applied
 * to the target resolution's linear luma.
 * @param {DehazeAux} aux
 * @param {number} u normalized x (pixel center / width)
 * @param {number} v normalized y
 * @param {number} yLin linear luma at the target pixel
 */
export function dehazeAmount(aux, u, v, yLin) {
  const { a, b, w, h } = aux;
  const fx = Math.min(Math.max(u * w - 0.5, 0), w - 1);
  const fy = Math.min(Math.max(v * h - 0.5, 0), h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const av =
    a[y0 * w + x0] * w00 +
    a[y0 * w + x1] * w10 +
    a[y1 * w + x0] * w01 +
    a[y1 * w + x1] * w11;
  const bv =
    b[y0 * w + x0] * w00 +
    b[y0 * w + x1] * w10 +
    b[y1 * w + x0] * w01 +
    b[y1 * w + x1] * w11;
  return Math.min(Math.max(av * yLin + bv, 0), 1);
}

/**
 * Materialize the refined haze amount for every pixel of a luma plane
 * (the preview path's R16F aux texture).
 * @param {DehazeAux} aux
 * @param {Float32Array} luma linear luma plane
 * @param {number} w @param {number} h
 */
export function computeDehazePlane(aux, luma, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      out[y * w + x] = dehazeAmount(aux, (x + 0.5) / w, v, luma[y * w + x]);
    }
  }
  return out;
}

// --- export pre-pass -----------------------------------------------------

/**
 * Fold the presence adjustments into a decoded image's linear data, in
 * place, before the per-pixel tone pipeline runs (the CPU counterpart of
 * the shader's step 0 — same formulas, same position: source-referred,
 * before white balance). `scale` is the full-res / preview width ratio so
 * the wavelet bands land on the same physical frequencies the preview
 * showed. No-op when all three sliders are zero.
 * @param {{ data: Uint16Array | Uint8Array, width: number, height: number,
 *           colors: number, bits: number }} image
 * @param {import("./tone-math.js").ToneSettings} settings
 * @param {number} [scale] integer ≥ 1
 */
export function applyPresencePrepass(image, settings, scale = 1) {
  const sharpening = settings.sharpening ?? 0;
  const texture = settings.texture ?? 0;
  const clarity = settings.clarity ?? 0;
  const dehaze = settings.dehaze ?? 0;
  // Negative NOISE slider = wavelet-shrinkage denoise on the finest band
  // (positive NOISE is chromatic noise added in the display post-step).
  const nr = Math.max(-(settings.noise ?? 0), 0);
  if (
    sharpening === 0 &&
    texture === 0 &&
    clarity === 0 &&
    dehaze === 0 &&
    nr === 0
  ) {
    return;
  }

  const { data, width, height, colors, bits } = image;
  const maxVal = bits === 16 ? 65535 : 255;
  const luma = lumaFromImage(image);
  const aux =
    dehaze !== 0 ? computeDehazeAux(downsampleRgbFromImage(image)) : null;
  const delta =
    texture !== 0 || clarity !== 0 || nr > 0
      ? computeDeltaPlane(luma, width, height, scale, texture, clarity, nr)
      : null;
  const sharpenDelta =
    sharpening !== 0
      ? computeSharpenDeltaPlane(luma, width, height, scale)
      : null;

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * colors;
      let r = decodeInput(data[p] / maxVal);
      let g = decodeInput(data[p + 1] / maxVal);
      let b = decodeInput(data[p + 2] / maxVal);
      if (aux) {
        const D = dehazeAmount(aux, (x + 0.5) / width, v, luma[i]);
        const t = dehazeTransmission(D, dehaze);
        const [ar, ag, ab] = aux.airlight;
        r = Math.max((r - ar) / t + ar, 0);
        g = Math.max((g - ag) / t + ag, 0);
        b = Math.max((b - ab) / t + ab, 0);
      }
      if (delta) {
        const ratio = presenceRatio(luma[i], delta[i]);
        r *= ratio;
        g *= ratio;
        b *= ratio;
      }
      if (sharpenDelta) {
        const ratio = sharpenRatio(luma[i], sharpenDelta[i], sharpening);
        r *= ratio;
        g *= ratio;
        b *= ratio;
      }
      data[p] = Math.min(Math.max(encodeInput(r) * maxVal + 0.5, 0), maxVal);
      data[p + 1] = Math.min(
        Math.max(encodeInput(g) * maxVal + 0.5, 0),
        maxVal,
      );
      data[p + 2] = Math.min(
        Math.max(encodeInput(b) * maxVal + 0.5, 0),
        maxVal,
      );
    }
  }
}
