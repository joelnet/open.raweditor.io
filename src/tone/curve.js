// Tone curve math, shared by the GLSL preview (which samples the LUT this
// module builds as an RGBA32F texture) and the CPU export (which calls
// applyCurveLut with the same table). See CURVE in constants.js for the
// design provenance; keep applyCurveLut and the shader's applyCurve()
// line-for-line in sync.

import { CURVE, LUMA } from "./constants.js";

/**
 * Control points of one channel, sorted by x, both axes in [0, 1].
 * Treat as immutable — always replace, never mutate in place.
 * @typedef {readonly (readonly [number, number])[]} CurvePoints
 */

/**
 * The four editable curves: `master` applies to all channels (after the
 * per-channel curves), `r`/`g`/`b` to their own channel only.
 * @typedef {{ master: CurvePoints, r: CurvePoints, g: CurvePoints,
 *             b: CurvePoints }} ToneCurve
 */

/** @type {CurvePoints} */
const IDENTITY_POINTS = Object.freeze([
  Object.freeze(/** @type {[number, number]} */ ([0, 0])),
  Object.freeze(/** @type {[number, number]} */ ([1, 1])),
]);

/** The identity curve — the ZERO_SETTINGS default. @type {ToneCurve} */
export const ZERO_CURVE = Object.freeze({
  master: IDENTITY_POINTS,
  r: IDENTITY_POINTS,
  g: IDENTITY_POINTS,
  b: IDENTITY_POINTS,
});

/** @param {number} v */
function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

/** @param {CurvePoints} points */
export function isIdentityPoints(points) {
  return (
    points.length === 2 &&
    points[0][0] === 0 &&
    points[0][1] === 0 &&
    points[1][0] === 1 &&
    points[1][1] === 1
  );
}

/** Identity curves gate the whole stage off (u_hasCurve / a null LUT).
 * @param {ToneCurve | null | undefined} curve */
export function isIdentityCurve(curve) {
  if (!curve) return true;
  return (
    isIdentityPoints(curve.master) &&
    isIdentityPoints(curve.r) &&
    isIdentityPoints(curve.g) &&
    isIdentityPoints(curve.b)
  );
}

/**
 * Monotone cubic (Fritsch–Carlson) interpolant through `points` as a
 * reusable evaluator. Points closer than 1e-6 in x collapse to the first,
 * so degenerate input can never divide by zero. Outside the outermost
 * points the curve continues linearly along the end tangent (then clamps
 * to [0, 1]), so a moved black/white point clips smoothly like ACR's.
 * @param {CurvePoints} points
 * @returns {(x: number) => number} evaluator, output clamped to [0, 1]
 */
export function curveMap(points) {
  /** @type {number[]} */
  const xs = [];
  /** @type {number[]} */
  const ys = [];
  for (const [px, py] of points) {
    if (xs.length && px - xs[xs.length - 1] < 1e-6) continue;
    xs.push(px);
    ys.push(py);
  }
  const n = xs.length;
  if (n === 0) return clamp01;
  if (n === 1) {
    const y0 = clamp01(ys[0]);
    return () => y0;
  }

  // secants, then Fritsch–Carlson tangents: average adjacent secants,
  // zero at local extrema, and rescale where α² + β² > 9 so the segment
  // can never overshoot its endpoints.
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++)
    d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  const m = new Float64Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] > 0 ? (d[i - 1] + d[i]) / 2 : 0;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  return (x) => {
    if (x <= xs[0]) return clamp01(ys[0] + m[0] * (x - xs[0]));
    if (x >= xs[n - 1]) return clamp01(ys[n - 1] + m[n - 1] * (x - xs[n - 1]));
    let i = 0;
    while (x >= xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return clamp01(
      ys[i] * (2 * t3 - 3 * t2 + 1) +
        h * m[i] * (t3 - 2 * t2 + t) +
        ys[i + 1] * (3 * t2 - 2 * t3) +
        h * m[i + 1] * (t3 - t2),
    );
  };
}

/**
 * Bake the four curves into one interleaved RGBA table: entry i holds the
 * r/g/b channel curves at x = i/(N-1) in .rgb and the master curve in .a —
 * exactly the RGBA32F texture layout the shader texelFetches.
 * @param {ToneCurve} curve
 * @returns {Float32Array} CURVE.LUT_SIZE × 4
 */
export function buildCurveLut(curve) {
  const n = CURVE.LUT_SIZE;
  const lut = new Float32Array(n * 4);
  const fr = curveMap(curve.r);
  const fg = curveMap(curve.g);
  const fb = curveMap(curve.b);
  const fm = curveMap(curve.master);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    lut[i * 4] = fr(x);
    lut[i * 4 + 1] = fg(x);
    lut[i * 4 + 2] = fb(x);
    lut[i * 4 + 3] = fm(x);
  }
  return lut;
}

/**
 * One channel of the LUT with linear interpolation between entries —
 * mirrors curveLutAt() in the shader (texelFetch + mix).
 * @param {Float32Array} lut from buildCurveLut
 * @param {0 | 1 | 2 | 3} ch r, g, b, or master
 * @param {number} x
 */
export function sampleCurveLut(lut, ch, x) {
  const t = clamp01(x) * (CURVE.LUT_SIZE - 1);
  const i = Math.floor(t);
  const j = Math.min(i + 1, CURVE.LUT_SIZE - 1);
  const f = t - i;
  return lut[i * 4 + ch] * (1 - f) + lut[j * 4 + ch] * f;
}

/**
 * Apply the tone curve to one display-referred sRGB pixel: channel curves
 * first at full effect, then the master curve with the REFINE SATURATION
 * blend — sat 1 applies it per channel (classic RGB curve), sat 0 as the
 * hue/sat-preserving luminance ratio master(Y)/Y. Mirrors applyCurve() in
 * gl/shaders.js.
 * @param {Float32Array} lut from buildCurveLut
 * @param {number} sat [0, 1]
 * @param {number} r @param {number} g @param {number} b
 * @returns {[number, number, number]}
 */
export function applyCurveLut(lut, sat, r, g, b) {
  const cr = sampleCurveLut(lut, 0, r);
  const cg = sampleCurveLut(lut, 1, g);
  const cb = sampleCurveLut(lut, 2, b);
  const fr = sampleCurveLut(lut, 3, cr);
  const fg = sampleCurveLut(lut, 3, cg);
  const fb = sampleCurveLut(lut, 3, cb);
  const y = LUMA[0] * cr + LUMA[1] * cg + LUMA[2] * cb;
  const my = sampleCurveLut(lut, 3, y);
  let nr, ng, nb;
  if (y > CURVE.LUMA_EPS) {
    const ratio = my / y;
    nr = cr * ratio;
    ng = cg * ratio;
    nb = cb * ratio;
  } else {
    nr = ng = nb = my;
  }
  return [
    clamp01(nr + (fr - nr) * sat),
    clamp01(ng + (fg - ng) * sat),
    clamp01(nb + (fb - nb) * sat),
  ];
}
