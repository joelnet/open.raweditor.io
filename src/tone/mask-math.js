// Geometry math for local adjustment masks (linear/radial gradients).
// The preview shader in gl/shaders.js implements the exact same weight
// functions on the GPU; keep the two in sync. All shape parameters are
// resolution-independent (image UV anchors, diagonal- or min-dimension-
// relative sizes) so the downscaled preview and the full-res export agree.

import { MASK } from "./constants.js";

/**
 * Per-mask local adjustments — the same keys and scales as the global
 * sliders, so the local math can reuse the TONE constants verbatim.
 * @typedef {{ temp: number, tint: number, exposure: number,
 *             contrast: number, highlights: number, shadows: number,
 *             whites: number, blacks: number, vibrance: number,
 *             saturation: number }} MaskAdjustments
 */

/**
 * One mask. `x`/`y` anchor in image UV (y = 0 at the top), `angle` in
 * radians. Linear masks use `range` (smoothstep half-width as a fraction
 * of the image diagonal; the weight ramps 0 → 1 along the angle
 * direction). Radial masks use `radiusX`/`radiusY` (semi-axes as
 * fractions of min(width, height)) and `feather` in [0, 1] (0 = hard
 * edge, 1 = falloff from the center). `enabled` is UI state: disabled
 * masks are neutralized before the settings reach the pipeline.
 * @typedef {{ type: "linear" | "radial", enabled: boolean,
 *             invert: boolean, x: number, y: number, angle: number,
 *             range: number, radiusX: number, radiusY: number,
 *             feather: number, adjustments: MaskAdjustments }} Mask
 */

/** @type {Readonly<MaskAdjustments>} */
export const ZERO_MASK_ADJUSTMENTS = Object.freeze({
  temp: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
});

/**
 * @param {number} x anchor, image UV
 * @param {number} y
 * @returns {Mask} a linear gradient selecting the area above the anchor
 */
export function createLinearMask(x = 0.5, y = 0.5) {
  return {
    type: "linear",
    enabled: true,
    invert: false,
    x,
    y,
    // pointing up: weight 1 at the top of the frame (the classic sky pull)
    angle: -Math.PI / 2,
    range: MASK.LINEAR_RANGE,
    radiusX: 0,
    radiusY: 0,
    feather: 0,
    adjustments: { ...ZERO_MASK_ADJUSTMENTS },
  };
}

/**
 * @param {number} x center, image UV
 * @param {number} y
 * @returns {Mask}
 */
export function createRadialMask(x = 0.5, y = 0.5) {
  return {
    type: "radial",
    enabled: true,
    invert: false,
    x,
    y,
    angle: 0,
    range: 0,
    radiusX: MASK.RADIAL_RADIUS[0],
    radiusY: MASK.RADIAL_RADIUS[1],
    feather: MASK.RADIAL_FEATHER,
    adjustments: { ...ZERO_MASK_ADJUSTMENTS },
  };
}

/**
 * Precomputed pixel-space form of a mask, for tight per-pixel loops.
 * @typedef {{ linear: boolean, cx: number, cy: number, cos: number,
 *             sin: number, invert: boolean, range: number, diag: number,
 *             a: number, b: number, ia: number, ib: number }} PreparedMask
 */

/**
 * Resolve a mask's normalized parameters against an image's pixel grid.
 * @param {Mask} mask
 * @param {number} width image px
 * @param {number} height
 * @returns {PreparedMask}
 */
export function prepareMask(mask, width, height) {
  const mind = Math.min(width, height);
  const a = Math.max(mask.radiusX, 1e-3) * mind;
  const b = Math.max(mask.radiusY, 1e-3) * mind;
  return {
    linear: mask.type === "linear",
    cx: mask.x * width,
    cy: mask.y * height,
    cos: Math.cos(mask.angle),
    sin: Math.sin(mask.angle),
    invert: mask.invert,
    range: Math.max(mask.range, 1e-4),
    diag: Math.hypot(width, height),
    a,
    b,
    ia: a * (1 - mask.feather),
    ib: b * (1 - mask.feather),
  };
}

/**
 * @param {number} e0
 * @param {number} e1
 * @param {number} x
 */
function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Mask weight at one pixel, in [0, 1].
 * @param {PreparedMask} p
 * @param {number} px pixel x (image space)
 * @param {number} py
 */
export function maskWeight(p, px, py) {
  const dx = px - p.cx;
  const dy = py - p.cy;
  let m;
  if (p.linear) {
    // signed distance along the gradient direction, diagonal-normalized,
    // through a smoothstep ramp (≈ darktable's erf sigmoid)
    const t = (p.cos * dx + p.sin * dy) / p.diag;
    m = smoothstep(-p.range, p.range, t);
  } else {
    // rotated ellipse: quadratic falloff in squared-radius space between
    // the inner (fully selected) and outer ellipse, per darktable
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-6) {
      m = 1;
    } else {
      const inv = 1 / Math.sqrt(l2);
      const cv = (dx * p.cos + dy * p.sin) * inv;
      const sv = (-dx * p.sin + dy * p.cos) * inv;
      const t2 =
        (p.a * p.a * p.b * p.b) / (p.a * p.a * sv * sv + p.b * p.b * cv * cv);
      const r2 =
        (p.ia * p.ia * p.ib * p.ib) /
        Math.max(p.ia * p.ia * sv * sv + p.ib * p.ib * cv * cv, 1e-9);
      const f = Math.min(Math.max((t2 - l2) / Math.max(t2 - r2, 1e-9), 0), 1);
      m = f * f;
    }
  }
  return p.invert ? 1 - m : m;
}

/**
 * Settings with disabled masks neutralized (geometry kept so mask indices
 * stay stable for the overlay visualization, adjustments zeroed) and the
 * list capped at the shader's uniform-array bound.
 * @template {{ masks: readonly Mask[] }} S
 * @param {S} settings
 * @param {boolean} [bypassAll] section eye: treat every mask as disabled
 * @returns {S}
 */
export function effectiveMasks(settings, bypassAll = false) {
  const masks = settings.masks ?? [];
  if (masks.length === 0) return settings;
  return {
    ...settings,
    masks: masks
      .slice(0, MASK.MAX)
      .map((m) =>
        m.enabled && !bypassAll
          ? m
          : { ...m, adjustments: { ...ZERO_MASK_ADJUSTMENTS } },
      ),
  };
}
