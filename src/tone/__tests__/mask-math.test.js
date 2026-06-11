import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLinearMask,
  createRadialMask,
  prepareMask,
  maskWeight,
  effectiveMasks,
  ZERO_MASK_ADJUSTMENTS,
} from "../mask-math.js";
import { ZERO_SETTINGS, applyTonePixel, srgbEncode } from "../tone-math.js";

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

// --- effectiveMasks ---

test("effectiveMasks neutralizes disabled masks but keeps their geometry", () => {
  const on = createRadialMask(0.5, 0.5);
  on.adjustments = { ...on.adjustments, exposure: 1 };
  const off = { ...createLinearMask(0.5, 0.5), enabled: false };
  off.adjustments = { ...off.adjustments, exposure: 2 };
  const s = effectiveMasks({ ...ZERO_SETTINGS, masks: [off, on] });
  assert.equal(s.masks.length, 2);
  assert.deepEqual(s.masks[0].adjustments, ZERO_MASK_ADJUSTMENTS);
  assert.equal(s.masks[1].adjustments.exposure, 1);
  assert.equal(s.masks[0].type, "linear");
});

test("effectiveMasks bypassAll neutralizes everything", () => {
  const on = createRadialMask(0.5, 0.5);
  on.adjustments = { ...on.adjustments, exposure: 1 };
  const s = effectiveMasks({ ...ZERO_SETTINGS, masks: [on] }, true);
  assert.deepEqual(s.masks[0].adjustments, ZERO_MASK_ADJUSTMENTS);
});

test("effectiveMasks with no masks returns settings unchanged", () => {
  assert.equal(effectiveMasks(ZERO_SETTINGS), ZERO_SETTINGS);
});
