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
 *             contrast: number, lightBalance: number, highlights: number,
 *             shadows: number, whites: number, blacks: number, sharpening: number,
 *             texture: number, clarity: number, dehaze: number,
 *             vibrance: number, saturation: number }} MaskAdjustments
 */

/**
 * One mask. `x`/`y` anchor in image UV (y = 0 at the top), `angle` in
 * radians. Linear masks use `range` (smoothstep half-width as a fraction
 * of the image diagonal; the weight ramps 0 → 1 along the angle
 * direction). Radial masks use `radiusX`/`radiusY` (semi-axes as
 * fractions of min(width, height)) and `feather` in [0, 1] (0 = hard
 * edge, 1 = falloff from the center). `enabled` is UI state: disabled
 * masks are neutralized before the settings reach the pipeline.
 *
 * Brush ("brush") masks are different: x/y/angle/range/radius are unused
 * and coverage comes from a raster (`coverage`, a Uint8Array of 0–255 in
 * normalized frame-UV space, `coverageW`×`coverageH`). The raster is
 * bilinearly sampled — preview and export agree because the grid is
 * resolution-independent (longest edge MASK.BRUSH_RES). `coverage` is
 * absent on masks that aren't brushes. (A darktable-style drawn
 * mask.) The painting UI mutates this Uint8Array *in place* during a stroke
 * (no per-move reallocation) and bumps `coverageVersion` to notify the
 * store; the renderer keys its per-layer GPU re-upload off that version,
 * and the export gets the raster for free via structured clone.
 * @typedef {{ type: "linear" | "radial" | "brush", enabled: boolean,
 *             invert: boolean, x: number, y: number, angle: number,
 *             range: number, radiusX: number, radiusY: number,
 *             feather: number, adjustments: MaskAdjustments,
 *             coverage?: Uint8Array | null, coverageW?: number,
 *             coverageH?: number, coverageVersion?: number }} Mask
 */

/** @type {Readonly<MaskAdjustments>} */
export const ZERO_MASK_ADJUSTMENTS = Object.freeze({
  temp: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  lightBalance: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  sharpening: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
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
 * Coverage-grid dimensions for a frame of width × height px: the longest
 * edge is MASK.BRUSH_RES texels, the short edge follows the frame aspect.
 * Resolution-independent — the same grid backs the preview and the export,
 * so a brush painted on the downscaled preview lands identically full-res.
 * @param {number} width frame px
 * @param {number} height frame px
 * @returns {{ w: number, h: number }}
 */
export function brushCoverageDims(width, height) {
  const long = Math.max(width, height, 1);
  const scale = MASK.BRUSH_RES / long;
  return {
    w: Math.max(1, Math.round(width * scale)),
    h: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * A fresh, empty (zero-coverage) brush mask.
 * @param {number} coverageW grid width  (see brushCoverageDims)
 * @param {number} coverageH grid height
 * @returns {Mask}
 */
export function createBrushMask(coverageW, coverageH) {
  return {
    type: "brush",
    enabled: true,
    invert: false,
    x: 0.5,
    y: 0.5,
    angle: 0,
    range: 0,
    radiusX: 0,
    radiusY: 0,
    feather: 0,
    adjustments: { ...ZERO_MASK_ADJUSTMENTS },
    coverage: new Uint8Array(coverageW * coverageH),
    coverageW,
    coverageH,
    coverageVersion: 0,
  };
}

/**
 * Stamp one soft circular brush dab into a coverage grid, in normalized
 * frame-UV space. Mirrors a darktable round brush: a radial
 * falloff from a hard inner core (`hardness`) out to the edge, accumulated
 * by `flow` (each dab adds toward full coverage; erase removes toward 0),
 * clamped to 0–255. The dab is circular in *frame px*, so it stays round
 * on non-square frames even though the grid is anisotropic in UV.
 *
 * @param {Uint8Array} cov coverage grid (mutated in place)
 * @param {number} gw grid width
 * @param {number} gh grid height
 * @param {number} ux dab center, frame UV [0, 1]
 * @param {number} uy
 * @param {number} radiusUv brush radius as a fraction of the longest frame
 *   edge (so it reads as a circle on screen)
 * @param {number} hardness [0, 1] — fraction of the radius that is full
 *   coverage before the falloff begins (1 = hard edge)
 * @param {number} flow [0, 1] — per-dab opacity
 * @param {boolean} erase subtract instead of add
 * @param {number} aspect frame width / height (to keep the dab circular)
 */
export function stampBrush(
  cov,
  gw,
  gh,
  ux,
  uy,
  radiusUv,
  hardness,
  flow,
  erase,
  aspect,
) {
  // Work in a normalized space where 1 unit = the longest frame edge, so
  // the dab is a true circle regardless of the grid's aspect. The grid's
  // longest edge spans 1 such unit; the short edge spans 1/aspect (wide)
  // or aspect (tall) — i.e. max(gw, gh) texels per unit.
  const per = Math.max(gw, gh); // texels per longest-edge unit
  const rPx = Math.max(radiusUv * per, 0.5); // dab radius in texels
  const cx = ux * gw;
  const cy = uy * gh;
  const x0 = Math.max(0, Math.floor(cx - rPx));
  const x1 = Math.min(gw - 1, Math.ceil(cx + rPx));
  const y0 = Math.max(0, Math.floor(cy - rPx));
  const y1 = Math.min(gh - 1, Math.ceil(cy + rPx));
  // hardness sets where the falloff starts; below it, full strength.
  const inner = Math.min(Math.max(hardness, 0), 1);
  const amt = Math.min(Math.max(flow, 0), 1) * 255;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / rPx;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rPx;
      const d = Math.hypot(dx, dy);
      if (d >= 1) continue;
      // smoothstep falloff from the hard core (inner) to the edge (1)
      let fall;
      if (d <= inner) fall = 1;
      else {
        const t = (d - inner) / Math.max(1 - inner, 1e-4);
        fall = 1 - t * t * (3 - 2 * t);
      }
      const add = amt * fall;
      if (add <= 0) continue;
      const i = y * gw + x;
      // Accumulate toward the dab target the way a flow-based brush does:
      // a single dab can lift coverage up to `add`, never past it, so
      // overlapping dabs in one stroke build smoothly without banding.
      const cur = cov[i];
      if (erase) {
        cov[i] = cur > add ? cur - add : 0;
      } else {
        cov[i] = cur < add ? Math.min(255, Math.round(add)) : cur;
      }
    }
  }
  // aspect is accepted for API symmetry / future elliptical brushes; the
  // circular-in-texels math above already respects the frame aspect via
  // the shared `per` scale, so no extra correction is needed here.
  void aspect;
}

/**
 * Precomputed pixel-space form of a mask, for tight per-pixel loops.
 * For brush masks, `brush` carries the coverage grid + dims and the
 * analytic fields are unused.
 * @typedef {{ linear: boolean, cx: number, cy: number, cos: number,
 *             sin: number, invert: boolean, range: number, diag: number,
 *             a: number, b: number, ia: number, ib: number,
 *             brush: { cov: Uint8Array, w: number, h: number,
 *                      fw: number, fh: number } | null }} PreparedMask
 */

/**
 * Resolve a shape's normalized parameters against an image's pixel grid.
 * Accepts a legacy Mask or a MaskComponent — both carry the same geometry
 * and coverage fields.
 * @param {Mask | MaskComponent} mask
 * @param {number} width image px
 * @param {number} height
 * @returns {PreparedMask}
 */
export function prepareMask(mask, width, height) {
  const mind = Math.min(width, height);
  const a = Math.max(mask.radiusX, 1e-3) * mind;
  const b = Math.max(mask.radiusY, 1e-3) * mind;
  // Brush masks carry a coverage raster; the analytic geometry is unused.
  const brush =
    mask.type === "brush" && mask.coverage && mask.coverageW && mask.coverageH
      ? {
          cov: mask.coverage,
          w: mask.coverageW,
          h: mask.coverageH,
          fw: width,
          fh: height,
        }
      : null;
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
    brush,
  };
}

/**
 * Bilinearly sample a coverage grid at frame UV (u, v), returning [0, 1].
 * Mirrors the GPU's LINEAR-filtered sampler2DArray fetch: half-texel
 * offset, clamp-to-edge at the borders.
 * @param {{ cov: Uint8Array, w: number, h: number }} b
 * @param {number} u frame UV [0, 1]
 * @param {number} v
 */
function sampleCoverage(b, u, v) {
  // Texel-center convention: UV 0..1 maps to texel centers 0.5..(N-0.5).
  const fx = u * b.w - 0.5;
  const fy = v * b.h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const cx0 = Math.min(Math.max(x0, 0), b.w - 1);
  const cx1 = Math.min(Math.max(x0 + 1, 0), b.w - 1);
  const cy0 = Math.min(Math.max(y0, 0), b.h - 1);
  const cy1 = Math.min(Math.max(y0 + 1, 0), b.h - 1);
  const c00 = b.cov[cy0 * b.w + cx0];
  const c10 = b.cov[cy0 * b.w + cx1];
  const c01 = b.cov[cy1 * b.w + cx0];
  const c11 = b.cov[cy1 * b.w + cx1];
  const top = c00 * (1 - tx) + c10 * tx;
  const bot = c01 * (1 - tx) + c11 * tx;
  return (top * (1 - ty) + bot * ty) / 255;
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
  let m;
  if (p.brush) {
    // raster coverage, bilinearly sampled at the pixel's frame UV — keep
    // in lockstep with the shader's sampler2DArray LINEAR fetch
    m = sampleCoverage(p.brush, px / p.brush.fw, py / p.brush.fh);
    return p.invert ? 1 - m : m;
  }
  const dx = px - p.cx;
  const dy = py - p.cy;
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

// ---------------------------------------------------------------------------
// Mask groups (compound masks)
//
// A mask is a *group*: one adjustment set applied through the composite of
// several live shape components. Each component is a linear/radial/brush
// shape — the same geometry and coverage fields as a legacy Mask — with a
// `mode` that decides whether it adds to or subtracts from the group's
// composite weight. Components stay parametric and individually re-editable;
// nothing is ever flattened to a raster (the Lightroom / Capture One 16.7
// model). The composite is order-independent:
//
//   A = 1 − Π over adds (1 − wᵢ)        probabilistic union ("screen")
//   W = A · Π over subtracts (1 − wⱼ)   each subtract is a soft eraser
//   W = group.invert ? 1 − W : W
//
// Screen over max(): the max of two smooth fields has a derivative crease
// along their equal-weight ridge, which reads as a tone crease when the
// mask drives exposure across a smooth sky; screen is C¹ there and mild
// overlap buildup is the intuitive "two coats" result. Intersect needs no
// operator of its own — a subtract component with `invert` multiplies the
// composite by that shape's weight.

/**
 * One shape inside a mask group. Same geometry/coverage semantics as Mask;
 * `invert` flips this shape's own weight before it enters the composite
 * (subtract + invert ≡ intersect). No per-component `enabled` or
 * `adjustments` — the group owns bypass and the adjustment set. `id` is the
 * stable identity for selection, overlays, and GPU brush-layer bookkeeping;
 * array indices are not identity.
 * @typedef {{ id: string, mode: "add" | "subtract",
 *             type: "linear" | "radial" | "brush", invert: boolean,
 *             x: number, y: number, angle: number, range: number,
 *             radiusX: number, radiusY: number, feather: number,
 *             coverage?: Uint8Array | null, coverageW?: number,
 *             coverageH?: number, coverageVersion?: number }} MaskComponent
 */

/**
 * A mask: one adjustment set applied through the composite of its
 * components. `invert` flips the final composite (not the children).
 * @typedef {{ id: string, enabled: boolean, invert: boolean,
 *             adjustments: MaskAdjustments,
 *             components: MaskComponent[] }} MaskGroup
 */

let idSeq = 0;
/**
 * Stable id for groups and components. randomUUID needs a secure context
 * and the dev server also runs on plain http origins, so fall back to a
 * counter + random suffix — ids only need to be unique within one edit.
 * @returns {string}
 */
export function newMaskId() {
  idSeq += 1;
  if (typeof globalThis.crypto?.randomUUID === "function")
    return crypto.randomUUID();
  return `m${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {Mask} mask shape donor; its coverage raster (if any) is adopted,
 *   not copied
 * @param {"add" | "subtract"} mode
 * @returns {MaskComponent}
 */
function componentFromMask(mask, mode) {
  /** @type {MaskComponent} */
  const component = {
    id: newMaskId(),
    mode,
    type: mask.type,
    invert: mask.invert,
    x: mask.x,
    y: mask.y,
    angle: mask.angle,
    range: mask.range,
    radiusX: mask.radiusX,
    radiusY: mask.radiusY,
    feather: mask.feather,
  };
  if (mask.type === "brush") {
    component.coverage = mask.coverage ?? null;
    component.coverageW = mask.coverageW;
    component.coverageH = mask.coverageH;
    component.coverageVersion = mask.coverageVersion ?? 0;
  }
  return component;
}

/**
 * @param {number} [x] anchor, image UV
 * @param {number} [y]
 * @param {"add" | "subtract"} [mode]
 * @returns {MaskComponent}
 */
export function createLinearComponent(x = 0.5, y = 0.5, mode = "add") {
  return componentFromMask(createLinearMask(x, y), mode);
}

/**
 * @param {number} [x] center, image UV
 * @param {number} [y]
 * @param {"add" | "subtract"} [mode]
 * @returns {MaskComponent}
 */
export function createRadialComponent(x = 0.5, y = 0.5, mode = "add") {
  return componentFromMask(createRadialMask(x, y), mode);
}

/**
 * @param {number} coverageW grid width (see brushCoverageDims)
 * @param {number} coverageH grid height
 * @param {"add" | "subtract"} [mode]
 * @returns {MaskComponent}
 */
export function createBrushComponent(coverageW, coverageH, mode = "add") {
  return componentFromMask(createBrushMask(coverageW, coverageH), mode);
}

/**
 * A new mask group around its first component.
 * @param {MaskComponent} component
 * @returns {MaskGroup}
 */
export function createMaskGroup(component) {
  return {
    id: newMaskId(),
    enabled: true,
    invert: false,
    adjustments: { ...ZERO_MASK_ADJUSTMENTS },
    components: [component],
  };
}

/**
 * Migrate a legacy single-shape mask to a group of one add component.
 * Renders identically: the group composite of one add component is that
 * component's weight, and the legacy `invert` moves onto the component.
 * The component adopts the legacy coverage raster (the caller discards the
 * legacy mask), the adjustments are copied.
 * @param {Mask} mask
 * @returns {MaskGroup}
 */
export function maskGroupFromLegacy(mask) {
  return {
    id: newMaskId(),
    enabled: mask.enabled,
    invert: false,
    adjustments: { ...mask.adjustments },
    components: [componentFromMask(mask, "add")],
  };
}

/**
 * Precomputed pixel-space form of a group, for tight per-pixel loops.
 * @typedef {{ invert: boolean,
 *             components: { subtract: boolean,
 *                           prepared: PreparedMask }[] }} PreparedGroup
 */

/**
 * Resolve a group's components against an image's pixel grid.
 * @param {MaskGroup} group
 * @param {number} width image px
 * @param {number} height
 * @returns {PreparedGroup}
 */
export function prepareGroup(group, width, height) {
  return {
    invert: group.invert,
    components: group.components.map((c) => ({
      subtract: c.mode === "subtract",
      prepared: prepareMask(c, width, height),
    })),
  };
}

/**
 * Composite group weight at one pixel, in [0, 1]. Order-independent (see
 * the section comment); a group with no add components weighs 0
 * everywhere — the UI warns about empty masks instead of special-casing
 * the math here.
 * @param {PreparedGroup} pg
 * @param {number} px pixel x (image space)
 * @param {number} py
 */
export function groupWeight(pg, px, py) {
  let addP = 1; // Π (1 − wᵢ) over add components
  let subP = 1; // Π (1 − wⱼ) over subtract components
  for (const c of pg.components) {
    const w = maskWeight(c.prepared, px, py);
    if (c.subtract) subP *= 1 - w;
    else addP *= 1 - w;
  }
  const w = (1 - addP) * subP;
  return pg.invert ? 1 - w : w;
}

/**
 * Bilinearly resample a coverage grid to new dimensions, preserving the
 * frame-UV field (texel-center convention, clamp-to-edge — the same
 * sampling the preview and export use, so the re-gridded raster renders
 * where the old one did).
 * @param {Uint8Array} cov
 * @param {number} w source grid width
 * @param {number} h
 * @param {number} nw target grid width
 * @param {number} nh
 * @returns {Uint8Array}
 */
export function resampleCoverage(cov, w, h, nw, nh) {
  const out = new Uint8Array(nw * nh);
  const src = { cov, w, h };
  for (let y = 0; y < nh; y++) {
    const v = (y + 0.5) / nh;
    for (let x = 0; x < nw; x++) {
      out[y * nw + x] = Math.round(
        sampleCoverage(src, (x + 0.5) / nw, v) * 255,
      );
    }
  }
  return out;
}

/**
 * Re-grid every brush component onto the frame's coverage grid. The GPU
 * uploads all brush rasters into one texture array sized from a single
 * grid, so "every raster matches the current frame's grid" is a hard
 * invariant — a 90° rotation swaps the frame dims and would otherwise
 * leave old brushes on a transposed grid (same byte count, so the upload
 * silently scrambles). Returns the new masks array, or null when every
 * raster already matches (the common case — angle-only geometry changes,
 * repeated calls).
 * @param {readonly MaskGroup[]} masks
 * @param {number} frameW frame px
 * @param {number} frameH
 * @returns {MaskGroup[] | null}
 */
export function normalizeBrushGrids(masks, frameW, frameH) {
  const { w, h } = brushCoverageDims(frameW, frameH);
  let changed = false;
  const next = masks.map((g) => {
    let groupChanged = false;
    const components = g.components.map((c) => {
      if (
        c.type !== "brush" ||
        !c.coverage ||
        !c.coverageW ||
        !c.coverageH ||
        (c.coverageW === w && c.coverageH === h)
      ) {
        return c;
      }
      groupChanged = true;
      return {
        ...c,
        coverage: resampleCoverage(c.coverage, c.coverageW, c.coverageH, w, h),
        coverageW: w,
        coverageH: h,
        coverageVersion: (c.coverageVersion ?? 0) + 1,
      };
    });
    if (!groupChanged) return g;
    changed = true;
    return { ...g, components };
  });
  return changed ? next : null;
}

/**
 * Group-model analog of effectiveMasks: disabled/bypassed groups keep
 * their components (so list indices stay stable for the overlay) with
 * adjustments zeroed, and the totals are held to the shader bounds —
 * MASK.MAX groups, MASK.MAX_COMPONENTS components overall,
 * MASK.MAX_BRUSH_COMPONENTS brush rasters overall. The UI enforces these
 * caps at creation time; this is the pipeline's guarantee against
 * over-budget persisted data.
 * @template {{ masks: readonly MaskGroup[] }} S
 * @param {S} settings
 * @param {boolean} [bypassAll] section eye: treat every group as disabled
 * @returns {S}
 */
export function effectiveMaskGroups(settings, bypassAll = false) {
  const groups = settings.masks ?? [];
  if (groups.length === 0) return settings;
  let comps = 0;
  let brushes = 0;
  return {
    ...settings,
    masks: groups.slice(0, MASK.MAX).map((g) => {
      /** @type {MaskComponent[]} */
      const components = [];
      for (const c of g.components) {
        if (comps >= MASK.MAX_COMPONENTS) break;
        if (c.type === "brush") {
          if (brushes >= MASK.MAX_BRUSH_COMPONENTS) continue;
          brushes += 1;
        }
        comps += 1;
        components.push(c);
      }
      const active = g.enabled && !bypassAll;
      if (active && components.length === g.components.length) return g;
      return {
        ...g,
        components,
        adjustments: active ? g.adjustments : { ...ZERO_MASK_ADJUSTMENTS },
      };
    }),
  };
}
