import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLinearMask,
  createRadialMask,
  createBrushMask,
  brushCoverageDims,
  stampBrush,
  prepareMask,
  maskWeight,
} from "../mask-math.js";
import { ZERO_SETTINGS, applyTonePixel, srgbEncode } from "../tone-math.js";
import { MASK } from "../constants.js";

const W = 4000;
const H = 3000;

/** @param {import("../mask-math.js").Mask} mask @param {number} u @param {number} v */
function weightAt(mask, u, v, w = W, h = H) {
  return maskWeight(prepareMask(mask, w, h), u * w, v * h);
}

// --- linear gradient ---

test("linear: weight is 0.5 on the anchor line", () => {
  const m = createLinearMask(0.5, 0.5);
  assert.ok(Math.abs(weightAt(m, 0.5, 0.5) - 0.5) < 1e-9);
  // anywhere along the line (perpendicular to the gradient direction)
  assert.ok(Math.abs(weightAt(m, 0.1, 0.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(weightAt(m, 0.9, 0.5) - 0.5) < 1e-9);
});

test("linear: default mask selects the top, releases the bottom", () => {
  const m = createLinearMask(0.5, 0.5);
  assert.equal(weightAt(m, 0.5, 0.0), 1);
  assert.equal(weightAt(m, 0.5, 1.0), 0);
});

test("linear: weight ramps monotonically across the band", () => {
  const m = createLinearMask(0.5, 0.5);
  let prev = Infinity;
  for (let v = 0; v <= 1.001; v += 0.05) {
    const w = weightAt(m, 0.5, v);
    assert.ok(w <= prev + 1e-12, `not monotone at v=${v}`);
    prev = w;
  }
});

test("linear: range sets the falloff band width (diagonal fraction)", () => {
  const m = { ...createLinearMask(0.5, 0.5), range: 0.1 };
  const diag = Math.hypot(W, H);
  // just inside / outside the half-width along the gradient direction (-y)
  const dy = 0.1 * diag;
  assert.equal(maskWeight(prepareMask(m, W, H), W / 2, H / 2 - dy - 1), 1);
  assert.equal(maskWeight(prepareMask(m, W, H), W / 2, H / 2 + dy + 1), 0);
  const inside = maskWeight(prepareMask(m, W, H), W / 2, H / 2 - dy / 2);
  assert.ok(inside > 0.5 && inside < 1);
});

test("linear: rotation works — angle 0 selects +x side", () => {
  const m = { ...createLinearMask(0.5, 0.5), angle: 0 };
  assert.equal(weightAt(m, 1, 0.5), 1);
  assert.equal(weightAt(m, 0, 0.5), 0);
});

test("linear: invert flips the weight", () => {
  const m = createLinearMask(0.5, 0.5);
  const inv = { ...m, invert: true };
  for (const v of [0, 0.3, 0.5, 0.7, 1]) {
    assert.ok(Math.abs(weightAt(m, 0.5, v) + weightAt(inv, 0.5, v) - 1) < 1e-9);
  }
});

test("linear: weight is resolution-independent", () => {
  const m = { ...createLinearMask(0.4, 0.6), angle: 0.7, range: 0.15 };
  for (const [u, v] of [
    [0.2, 0.3],
    [0.5, 0.5],
    [0.8, 0.9],
  ]) {
    const full = weightAt(m, u, v, 9504, 6336);
    const preview = weightAt(m, u, v, 1188, 792);
    assert.ok(Math.abs(full - preview) < 1e-9, `(${u}, ${v})`);
  }
});

// --- radial / ellipse ---

test("radial: center is fully selected, far outside is 0", () => {
  const m = createRadialMask(0.5, 0.5);
  assert.equal(weightAt(m, 0.5, 0.5), 1);
  assert.equal(weightAt(m, 0, 0), 0);
  assert.equal(weightAt(m, 1, 1), 0);
});

test("radial: drawn ellipse is the outer boundary of the feather band", () => {
  const mind = Math.min(W, H);
  const m = { ...createRadialMask(0.5, 0.5), radiusX: 0.3, radiusY: 0.2 };
  const p = prepareMask(m, W, H);
  // just outside the outer ellipse along +x: weight 0
  assert.equal(maskWeight(p, W / 2 + 0.3 * mind + 2, H / 2), 0);
  // halfway into the feather band: strictly between 0 and 1
  const inner = 0.3 * mind * (1 - m.feather);
  const mid = (inner + 0.3 * mind) / 2;
  const w = maskWeight(p, W / 2 + mid, H / 2);
  assert.ok(w > 0 && w < 1, `feather band weight ${w}`);
  // inside the inner ellipse: fully selected
  assert.equal(maskWeight(p, W / 2 + inner - 2, H / 2), 1);
});

test("radial: feather 0 is a hard edge", () => {
  const m = {
    ...createRadialMask(0.5, 0.5),
    feather: 0,
    radiusX: 0.25,
    radiusY: 0.25,
  };
  const mind = Math.min(W, H);
  const p = prepareMask(m, W, H);
  assert.equal(maskWeight(p, W / 2 + 0.25 * mind - 2, H / 2), 1);
  assert.equal(maskWeight(p, W / 2 + 0.25 * mind + 2, H / 2), 0);
});

test("radial: stays a true ellipse on non-square images", () => {
  // circle params on a 2:1 image — weight at equal pixel distances along
  // x and y must match (aspect must not stretch the shape)
  const m = { ...createRadialMask(0.5, 0.5), radiusX: 0.2, radiusY: 0.2 };
  const p = prepareMask(m, 4000, 2000);
  const d = 0.2 * 2000 * 0.9; // 90% of the radius, in px
  const wx = maskWeight(p, 2000 + d, 1000);
  const wy = maskWeight(p, 2000, 1000 + d);
  assert.ok(Math.abs(wx - wy) < 1e-9);
});

test("radial: rotation swaps the long axis", () => {
  const m = {
    ...createRadialMask(0.5, 0.5),
    radiusX: 0.3,
    radiusY: 0.1,
    feather: 0,
    angle: Math.PI / 2,
  };
  const mind = Math.min(W, H);
  const p = prepareMask(m, W, H);
  // rotated 90°: long axis now vertical
  assert.equal(maskWeight(p, W / 2, H / 2 + 0.25 * mind), 1);
  assert.equal(maskWeight(p, W / 2 + 0.25 * mind, H / 2), 0);
});

test("radial: invert selects the outside", () => {
  const m = { ...createRadialMask(0.5, 0.5), invert: true };
  assert.equal(weightAt(m, 0.5, 0.5), 0);
  assert.equal(weightAt(m, 0, 0), 1);
});

// --- brush (drawn) mask: coverage raster, bilinear sampling ---

/**
 * Build a brush mask whose coverage is a known tiny grid (row-major, 0–255).
 * @param {number[]} values @param {number} w @param {number} h
 */
function brushFromGrid(values, w, h) {
  const m = createBrushMask(w, h);
  m.coverage = Uint8Array.from(values);
  return m;
}

test("brushCoverageDims: longest edge is BRUSH_RES, aspect preserved", () => {
  const wide = brushCoverageDims(4000, 2000);
  assert.equal(Math.max(wide.w, wide.h), MASK.BRUSH_RES);
  assert.equal(wide.w, MASK.BRUSH_RES);
  assert.equal(wide.h, MASK.BRUSH_RES / 2);
  const tall = brushCoverageDims(3000, 4000);
  assert.equal(Math.max(tall.w, tall.h), MASK.BRUSH_RES);
  assert.equal(tall.h, MASK.BRUSH_RES);
});

test("brush: samples the grid value at texel centers", () => {
  // 2×2 grid: top-left 255, rest 0. Texel centers are at UV 0.25 / 0.75.
  const m = brushFromGrid([255, 0, 0, 0], 2, 2);
  const p = prepareMask(m, 100, 100);
  // dead-center of texel (0,0): full coverage
  assert.ok(Math.abs(maskWeight(p, 25, 25) - 1) < 1e-9);
  // dead-center of texel (1,1): zero
  assert.ok(Math.abs(maskWeight(p, 75, 75) - 0) < 1e-9);
});

test("brush: bilinear interpolates between texels", () => {
  // 2×1 grid: left 0, right 255 → midpoint (UV 0.5) is 0.5.
  const m = brushFromGrid([0, 255], 2, 1);
  const p = prepareMask(m, 100, 100);
  const mid = maskWeight(p, 50, 50);
  assert.ok(Math.abs(mid - 0.5) < 1e-9, `midpoint ${mid}`);
  // quarter of the way (UV 0.375 between texel centers 0.25..0.75) → 0.25
  const q = maskWeight(p, 37.5, 50);
  assert.ok(Math.abs(q - 0.25) < 1e-9, `quarter ${q}`);
});

test("brush: clamps to edge outside the texel-center range", () => {
  // a sample left of the first texel center stays at the first value
  const m = brushFromGrid([0, 255], 2, 1);
  const p = prepareMask(m, 100, 100);
  assert.equal(maskWeight(p, 0, 50), 0); // UV 0, before center 0.25 → clamp 0
  assert.equal(maskWeight(p, 100, 50), 1); // UV 1, past center 0.75 → clamp 255
});

test("brush: invert flips the coverage", () => {
  const m = brushFromGrid([255, 0, 0, 0], 2, 2);
  const inv = { ...m, invert: true };
  const p = prepareMask(m, 100, 100);
  const pi = prepareMask(inv, 100, 100);
  for (const [px, py] of [
    [25, 25],
    [75, 75],
    [50, 50],
  ]) {
    assert.ok(
      Math.abs(maskWeight(p, px, py) + maskWeight(pi, px, py) - 1) < 1e-9,
      `(${px}, ${py})`,
    );
  }
});

test("brush: coverage is resolution-independent (preview ↔ full-res)", () => {
  // a 4×4 ramp grid sampled at the same UV must match at any frame size
  const grid = [];
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) grid.push(Math.round((x / 3) * 255));
  const m = brushFromGrid(grid, 4, 4);
  for (const [u, v] of [
    [0.2, 0.3],
    [0.5, 0.5],
    [0.85, 0.65],
  ]) {
    const full = maskWeight(prepareMask(m, 8000, 6000), u * 8000, v * 6000);
    const prev = maskWeight(prepareMask(m, 800, 600), u * 800, v * 600);
    assert.ok(Math.abs(full - prev) < 1e-9, `(${u}, ${v})`);
  }
});

test("stampBrush: a dab marks the center and falls off to the edge", () => {
  const dims = brushCoverageDims(1000, 1000);
  const cov = new Uint8Array(dims.w * dims.h);
  // hard-ish dab at the center, full flow
  stampBrush(cov, dims.w, dims.h, 0.5, 0.5, 0.1, 1, 1, false, 1);
  const m = brushFromGrid([...cov], dims.w, dims.h);
  const p = prepareMask(m, 1000, 1000);
  // center fully covered, far corner untouched
  assert.ok(maskWeight(p, 500, 500) > 0.99);
  assert.equal(maskWeight(p, 10, 10), 0);
});

test("stampBrush: erase subtracts from existing coverage", () => {
  const dims = brushCoverageDims(1000, 1000);
  const cov = new Uint8Array(dims.w * dims.h).fill(255);
  // erase a hard dab at the center
  stampBrush(cov, dims.w, dims.h, 0.5, 0.5, 0.1, 1, 1, true, 1);
  const m = brushFromGrid([...cov], dims.w, dims.h);
  const p = prepareMask(m, 1000, 1000);
  assert.ok(maskWeight(p, 500, 500) < 0.01); // center cleared
  assert.equal(maskWeight(p, 10, 10), 1); // far corner still full
});

test("brush: applies its adjustments through the tone pipeline", () => {
  // full coverage everywhere → behaves like a global exposure of +1.5 EV
  const dims = { w: 2, h: 2 };
  const m = brushFromGrid([255, 255, 255, 255], dims.w, dims.h);
  m.adjustments = { ...m.adjustments, exposure: 1.5 };
  const s = { ...ZERO_SETTINGS, masks: [m] };
  const p = prepareMask(m, 100, 100);
  const w = maskWeight(p, 50, 50);
  const local = applyTonePixel(0.1, 0.1, 0.1, s, [w]);
  const global = applyTonePixel(0.1, 0.1, 0.1, {
    ...ZERO_SETTINGS,
    exposure: 1.5,
  });
  assert.ok(Math.abs(local[0] - global[0]) < 1e-9);
});

// --- application through the tone pipeline ---

test("mask weight 0 leaves the pixel untouched even with big adjustments", () => {
  const mask = createLinearMask(0.5, 0.5);
  mask.adjustments = {
    ...mask.adjustments,
    exposure: 3,
    contrast: 1,
    saturation: 1,
  };
  const s = { ...ZERO_SETTINGS, masks: [mask] };
  const [r] = applyTonePixel(0.18, 0.18, 0.18, s, [0]);
  assert.ok(Math.abs(r - srgbEncode(0.18)) < 1e-9);
});

test("mask weight 1 exposure matches the global exposure slider", () => {
  const mask = createLinearMask(0.5, 0.5);
  mask.adjustments = { ...mask.adjustments, exposure: 1.5 };
  const local = applyTonePixel(
    0.1,
    0.1,
    0.1,
    { ...ZERO_SETTINGS, masks: [mask] },
    [1],
  );
  const global = applyTonePixel(0.1, 0.1, 0.1, {
    ...ZERO_SETTINGS,
    exposure: 1.5,
  });
  assert.ok(Math.abs(local[0] - global[0]) < 1e-9);
});

test("mask exposure is additive in EV with the weight (half weight = half stops)", () => {
  const mask = createLinearMask(0.5, 0.5);
  mask.adjustments = { ...mask.adjustments, exposure: 2 };
  const half = applyTonePixel(
    0.1,
    0.1,
    0.1,
    { ...ZERO_SETTINGS, masks: [mask] },
    [0.5],
  );
  const oneEv = applyTonePixel(0.1, 0.1, 0.1, {
    ...ZERO_SETTINGS,
    exposure: 1,
  });
  assert.ok(Math.abs(half[0] - oneEv[0]) < 1e-9);
});

test("masks stack: two masks apply sequentially", () => {
  const a = createLinearMask(0.5, 0.5);
  a.adjustments = { ...a.adjustments, exposure: 1 };
  const b = createRadialMask(0.5, 0.5);
  b.adjustments = { ...b.adjustments, exposure: 1 };
  const both = applyTonePixel(
    0.05,
    0.05,
    0.05,
    { ...ZERO_SETTINGS, masks: [a, b] },
    [1, 1],
  );
  const twoEv = applyTonePixel(0.05, 0.05, 0.05, {
    ...ZERO_SETTINGS,
    exposure: 2,
  });
  assert.ok(Math.abs(both[0] - twoEv[0]) < 1e-9);
});

// (effectiveMaskGroups — the group-model settings adapter — is covered in
// mask-groups.test.js.)
