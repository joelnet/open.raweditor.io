// Auto white balance and auto tone: image statistics over the linear
// preview buffer, solved against the tone pipeline's own math so each
// slider value traces to a named statistic. The methods follow the
// open-source raw editors: WB is gray-world with clip/saturation
// rejection (LibRaw use_auto_wb, OpenCV GrayworldWB) refined by
// iterative near-gray selection (Huo et al. 2006), which ignores
// dominant colored subjects; tone takes exposure from the median in
// log2 space (darktable deflicker), white/black points from percentiles
// of max(R,G,B) / luma (dcraw auto-bright, RawTherapee Auto Levels,
// GIMP levels stretch), contrast from quantile spread (RawTherapee
// ospread), and shadows/highlights as conservative residual corrections
// — shadows only floors crushed blacks and backs off entirely when deep
// shadow is the scene's character.

import { TONE, LUMA } from "./constants.js";
import { decodeInput } from "./tone-math.js";

/**
 * @typedef {{ pixels: Uint16Array, width: number, height: number }} Preview
 * @typedef {{ x: number, y: number, w: number, h: number }} PixelRect
 */

/** Cap on sampled pixels per statistics pass (grid-subsampled). */
const SAMPLE_TARGET = 1 << 18;

/** Log2-domain histogram layout: 1024 bins spanning 2^-14 … 2^2. */
const HIST_BINS = 1024;
const HIST_MIN_EV = -14;
const HIST_MAX_EV = 2;
const BINS_PER_EV = HIST_BINS / (HIST_MAX_EV - HIST_MIN_EV);

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/** @param {number} e0 @param {number} e1 @param {number} x */
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Round to the slider's step so the store matches what the UI shows. */
/** @param {number} v @param {number} step */
function roundStep(v, step) {
  return Math.round(v / step) * step;
}

/** Grid stride that keeps a rect's sample count near SAMPLE_TARGET. */
/** @param {PixelRect} rect */
function sampleStep(rect) {
  return Math.max(1, Math.round(Math.sqrt((rect.w * rect.h) / SAMPLE_TARGET)));
}

/**
 * Visit a uniform grid of samples (linear light, decoded) inside rect.
 * @param {Preview} preview
 * @param {PixelRect} rect
 * @param {(r: number, g: number, b: number) => void} fn
 * @returns {number} samples visited
 */
function forEachSample(preview, rect, fn) {
  const { pixels, width } = preview;
  const step = sampleStep(rect);
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += step) {
    for (let x = rect.x; x < rect.x + rect.w; x += step) {
      const i = (y * width + x) * 4;
      fn(
        decodeInput(pixels[i] / 65535),
        decodeInput(pixels[i + 1] / 65535),
        decodeInput(pixels[i + 2] / 65535),
      );
      count++;
    }
  }
  return count;
}

/** @param {number} v linear value */
function binOf(v) {
  const ev = Math.log2(Math.max(v, 2 ** HIST_MIN_EV));
  return Math.min(Math.floor((ev - HIST_MIN_EV) * BINS_PER_EV), HIST_BINS - 1);
}

/**
 * Linear value of the p-th percentile of a log2-domain histogram.
 * @param {Uint32Array} hist @param {number} count @param {number} p 0..100
 */
function percentile(hist, count, p) {
  const target = (p / 100) * count;
  let cum = 0;
  for (let bin = 0; bin < HIST_BINS; bin++) {
    cum += hist[bin];
    if (cum >= target) {
      return 2 ** (HIST_MIN_EV + (bin + 0.5) / BINS_PER_EV);
    }
  }
  return 2 ** HIST_MAX_EV;
}

// --- auto white balance ---

/** Any channel above this is treated as clipped (box downscale softens
 * true clips, so stricter than dcraw's maximum-25). */
const WB_CLIP_HI = 0.95;
/** Luma below this is noise floor — no usable color. */
const WB_DARK_LO = 0.002;
/** Stage-1 saturation rejection: (max-min)/max above this is excluded
 * from the gray-world average (OpenCV GrayworldWB default). */
const WB_SAT_MAX = 0.9;
/** Near-gray thresholds per refinement pass, (|U|+|V|)/Y in Rec.601 YUV.
 * Starts loose so an off camera WB still captures grays, ends at Huo et
 * al.'s published 0.097-ish value so only true neutrals vote. */
const WB_GRAY_T = [0.3, 0.2, 0.15, 0.1];
/** Refinement needs at least this fraction of near-gray samples;
 * otherwise the scene has no neutrals and gray-world stands. */
const WB_MIN_GRAY_FRAC = 0.02;
/** Sanity clamp on estimated channel gains. */
const WB_GAIN_LO = 0.25;
const WB_GAIN_HI = 4;

/**
 * Auto white balance: estimate the residual R/B gains that neutralize
 * the (already camera-white-balanced) preview, then express them as the
 * pipeline's temp/tint sliders.
 *
 * Stage 1 is gray world over clip/dark/saturation-filtered samples;
 * stage 2 re-averages only near-gray pixels (judged under the current
 * gain estimate) with a tightening threshold, so dominant colored
 * subjects stop voting. The slider model applies gains
 * (2^(a·temp), 2^(-b·tint), 2^(-a·temp)), so green-normalized gains
 * (kR, 1, kB) convert exactly — after factoring out the brightness
 * scale the model can't express — to:
 *   temp = log2(kR/kB) / 2a,  tint = log2(kR·kB) / 2b.
 * @param {Preview} preview
 * @param {PixelRect} rect crop window in preview pixels
 * @returns {{ temp: number, tint: number }}
 */
export function autoWhiteBalance(preview, rect) {
  const step = sampleStep(rect);
  const maxKept = Math.ceil(rect.h / step) * Math.ceil(rect.w / step);
  // clip/dark-filtered samples, kept for the refinement passes
  const kept = new Float32Array(maxKept * 3);
  let keptLen = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let n = 0;
  forEachSample(preview, rect, (r, g, b) => {
    const mx = Math.max(r, g, b);
    if (mx > WB_CLIP_HI) return; // clipped — the color is a lie
    if (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b < WB_DARK_LO) return;
    kept[keptLen] = r;
    kept[keptLen + 1] = g;
    kept[keptLen + 2] = b;
    keptLen += 3;
    if (mx - Math.min(r, g, b) > WB_SAT_MAX * mx) return;
    sumR += r;
    sumG += g;
    sumB += b;
    n++;
  });
  if (n < 100 || sumR <= 0 || sumB <= 0) return { temp: 0, tint: 0 };

  let kR = clamp(sumG / sumR, WB_GAIN_LO, WB_GAIN_HI);
  let kB = clamp(sumG / sumB, WB_GAIN_LO, WB_GAIN_HI);

  for (let pass = 0; pass < WB_GRAY_T.length; pass++) {
    const t = WB_GRAY_T[pass];
    // The first pass judges "near gray" under identity gains: the data is
    // already camera-white-balanced, so true neutrals sit near R=G=B even
    // when a dominant colored subject has skewed the gray-world seed.
    // Later passes judge under the evolving estimate.
    const jR = pass === 0 ? 1 : kR;
    const jB = pass === 0 ? 1 : kB;
    let gR = 0;
    let gG = 0;
    let gB = 0;
    let m = 0;
    for (let i = 0; i < keptLen; i += 3) {
      // chroma under the judging gains; accumulate uncorrected values
      const r = kept[i] * jR;
      const g = kept[i + 1];
      const b = kept[i + 2] * jB;
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const u = 0.492 * (b - y);
      const v = 0.877 * (r - y);
      if (Math.abs(u) + Math.abs(v) < t * Math.max(y, 1e-6)) {
        gR += kept[i];
        gG += kept[i + 1];
        gB += kept[i + 2];
        m++;
      }
    }
    if (m < WB_MIN_GRAY_FRAC * n || gR <= 0 || gB <= 0) break;
    const nextR = clamp(gG / gR, WB_GAIN_LO, WB_GAIN_HI);
    const nextB = clamp(gG / gB, WB_GAIN_LO, WB_GAIN_HI);
    const converged =
      Math.abs(nextR / kR - 1) < 0.001 && Math.abs(nextB / kB - 1) < 0.001;
    kR = nextR;
    kB = nextB;
    if (converged) break;
  }

  return {
    temp: roundStep(
      clamp(Math.log2(kR / kB) / (2 * TONE.WB_TEMP_EV), -1, 1),
      0.01,
    ),
    tint: roundStep(
      clamp(Math.log2(kR * kB) / (2 * TONE.WB_TINT_EV), -1, 1),
      0.01,
    ),
  };
}

// --- auto tone ---

/** Shadows lift only fires when the 10th percentile sits below this. */
const SHADOW_FLOOR = 0.01;
/** Luma below this counts toward the "deep shadow" mass. */
const DARK_LUMA = 0.03;
/** smoothstep edges on the deep-shadow fraction: at 10 % of the frame the
 * shadows lift starts fading, at 35 % darkness is the scene's character
 * and the lift is fully suppressed. */
const DARK_CHARACTER = [0.1, 0.35];

/**
 * @typedef {{ exposure: number, contrast: number, highlights: number,
 *             shadows: number, whites: number, blacks: number }} AutoToneResult
 */

/** Tone sliders at rest — the bail-out result when statistics are unusable. */
/** @type {AutoToneResult} */
const ZERO_TONE = Object.freeze({
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
});

/**
 * Derive tone sliders for one exposure candidate. Pure math over the
 * percentile stats; mid reports where the median lands so the caller can
 * refine exposure once.
 * @param {number} exposure EV
 * @param {{ B: number, M: number, W: number, q12: number, q87: number,
 *           p10: number, w99: number, darkDamp: number }} s percentile
 *   stats (linear) plus the deep-shadow damping factor
 */
function deriveTone(exposure, s) {
  const g = 2 ** exposure;
  const black = 0.9 * s.B * g; // leave a hair of toe, don't crush to 0
  const blacks = clamp(-black / TONE.BLACKS_RANGE, -1, 0);
  const blackA = -TONE.BLACKS_RANGE * blacks;
  const Wp = s.W * g;

  // contrast: power curve scales log-distance from the pivot by (1 + C),
  // so C that widens the 12.5–87.5 % spread to 4 stops is exact…
  const lev0 = (/** @type {number} */ x) =>
    Math.max((x * g - blackA) / Math.max(Wp - blackA, 1e-6), 1e-6);
  const spread = Math.log2(lev0(s.q87) / lev0(s.q12));
  let contrast = clamp(4.0 / Math.max(spread, 1e-3) - 1, 0, 0.35);
  // …capped so the white-point compensation below stays inside ~80 % of
  // the whites slider's reach. The curve pivots on 0.18, so it brightens
  // the top end and the white point must stretch to pay for it; without
  // this cap a bright-topped image pegs whites at -100.
  const reach = 1 + 0.8 * TONE.WHITES_RANGE;
  const uReq = (Wp - blackA) / (reach - blackA);
  const cMax = uReq >= 1 ? 1 : 1 / (1 - Math.log(uReq) / Math.log(TONE.PIVOT));
  contrast = clamp(Math.min(contrast, cMax - 1), 0, 0.35);
  const c = 1 + contrast;

  // whites: place the levels white so the 99.8th percentile of
  // max(R,G,B) lands at 1.0 *after* the contrast power curve.
  const uW = TONE.PIVOT ** (1 - 1 / c);
  const white = blackA + (Wp - blackA) / uW;
  const whites = clamp((1 - white) / TONE.WHITES_RANGE, -1, 1);

  // composed map (exposure → levels → contrast) with the *achieved*
  // slider values, so the residual corrections see the real pipeline.
  const whiteA = 1 - TONE.WHITES_RANGE * whites;
  const T = (/** @type {number} */ x) => {
    const v = Math.max((x * g - blackA) / Math.max(whiteA - blackA, 1e-4), 0);
    return contrast > 0 ? TONE.PIVOT * (v / TONE.PIVOT) ** c : v;
  };
  const maskAt = (/** @type {number} */ y) =>
    1 -
    smoothstep(
      TONE.SHADOW_MASK[0],
      TONE.SHADOW_MASK[1],
      Math.sqrt(clamp(y, 0, 1)),
    );

  // shadows: a crushed-blacks floor only — lift the 10th percentile to
  // SHADOW_FLOOR, damped to zero as deep shadow becomes the scene's
  // dominant character (dark backgrounds, night, low-key are a look, not
  // a defect). Deliberately conservative: every real photo has clipped
  // speculars that white-cap exposure, and routing the resulting midtone
  // deficit into shadows washed out every test image at +41…+70.
  const y10 = T(s.p10);
  const m10 = maskAt(y10);
  const shadows =
    y10 > 0 && y10 < SHADOW_FLOOR && m10 > 0.3
      ? clamp(
          (Math.log2(SHADOW_FLOOR / y10) / (TONE.SH_STRENGTH_EV * m10)) *
            s.darkDamp,
          0,
          0.4,
        )
      : 0;
  const mid = T(s.M);

  // highlights: residual EV to bring the 99th percentile back under clip.
  const y99 = T(s.w99);
  const highlights =
    y99 > 1 ? -clamp(Math.log2(y99) / TONE.SH_STRENGTH_EV, 0, 1) : 0;

  return { exposure, contrast, highlights, shadows, whites, blacks, mid };
}

/**
 * Auto tone: set exposure/contrast/whites/blacks/shadows/highlights from
 * percentiles of the (white-balanced) linear preview. wb is the effective
 * temp/tint, since white balance runs upstream of tone in the pipeline.
 * @param {Preview} preview
 * @param {PixelRect} rect crop window in preview pixels
 * @param {{ temp: number, tint: number }} wb
 * @returns {AutoToneResult}
 */
export function autoTone(preview, rect, wb) {
  const gainR = 2 ** (TONE.WB_TEMP_EV * wb.temp);
  const gainG = 2 ** (-TONE.WB_TINT_EV * wb.tint);
  const gainB = 2 ** (-TONE.WB_TEMP_EV * wb.temp);

  const histY = new Uint32Array(HIST_BINS);
  const histN = new Uint32Array(HIST_BINS);
  const count = forEachSample(preview, rect, (r, g, b) => {
    r *= gainR;
    g *= gainG;
    b *= gainB;
    histY[binOf(LUMA[0] * r + LUMA[1] * g + LUMA[2] * b)]++;
    histN[binOf(Math.max(r, g, b))]++;
  });

  const P = (/** @type {Uint32Array} */ h, /** @type {number} */ p) =>
    percentile(h, count, p);
  // deep-shadow fraction → how much of the shadows lift the scene allows
  let darkCount = 0;
  for (let bin = 0; bin < binOf(DARK_LUMA); bin++) darkCount += histY[bin];
  const stats = {
    B: P(histY, 0.2), // black point
    M: P(histY, 50), // mid-tone anchor
    q12: P(histY, 12.5), // contrast spread, low
    q87: P(histY, 87.5), // contrast spread, high
    p10: P(histY, 10), // shadows decision
    W: P(histN, 99.8), // white point, max(R,G,B) so no channel clips
    w99: P(histN, 99), // highlights decision
    darkDamp:
      1 - smoothstep(DARK_CHARACTER[0], DARK_CHARACTER[1], darkCount / count),
  };
  if (count < 1000 || stats.M < 1e-5 || stats.W <= stats.B) {
    return { ...ZERO_TONE };
  }

  // exposure: median → 18 % gray, capped at the white point's real
  // headroom: 0.3 EV past white-preserving is what whites = -100 (white
  // point 1.25) can pull back. Pushing further would either peg whites
  // or gray out data already clipped at the sensor.
  const ev = clamp(
    Math.min(Math.log2(TONE.PIVOT / stats.M), Math.log2(0.95 / stats.W) + 0.3),
    -2.5,
    2.5,
  );
  let out = deriveTone(ev, stats);
  // one refinement, downward only: if the composed map landed the median
  // *above* 18 % gray (contrast push), back exposure off. A median still
  // below target stays below — the headroom cap exists to protect the
  // top end, and pushing harder is what blows skies and washes out
  // intentionally dark scenes.
  const drift = out.mid > 1e-6 ? Math.log2(out.mid / TONE.PIVOT) : 0;
  if (drift > 0.15) {
    out = deriveTone(clamp(ev - 0.5 * drift, -2.5, 2.5), stats);
  }

  return {
    exposure: roundStep(out.exposure, 0.05),
    contrast: roundStep(out.contrast, 0.01),
    highlights: roundStep(out.highlights, 0.01),
    shadows: roundStep(out.shadows, 0.01),
    whites: roundStep(out.whites, 0.01),
    blacks: roundStep(out.blacks, 0.01),
  };
}
