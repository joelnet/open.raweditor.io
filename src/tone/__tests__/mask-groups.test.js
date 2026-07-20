import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLinearMask,
  createRadialMask,
  createBrushMask,
  createLinearComponent,
  createRadialComponent,
  createBrushComponent,
  createMaskGroup,
  maskGroupFromLegacy,
  prepareMask,
  maskWeight,
  prepareGroup,
  groupWeight,
  effectiveMaskGroups,
  resampleCoverage,
  normalizeBrushGrids,
  brushCoverageDims,
  ZERO_MASK_ADJUSTMENTS,
} from "../mask-math.js";
import { ZERO_SETTINGS } from "../tone-math.js";
import { MASK } from "../constants.js";

const W = 4000;
const H = 3000;

/** UV sample points covering distinct regions of the frame. */
const SAMPLES = [
  [0.1, 0.1],
  [0.5, 0.1],
  [0.9, 0.1],
  [0.1, 0.5],
  [0.5, 0.5],
  [0.9, 0.5],
  [0.1, 0.9],
  [0.5, 0.9],
  [0.9, 0.9],
  [0.3, 0.7],
  [0.7, 0.3],
];

/** @param {import("../mask-math.js").MaskGroup} group */
function gw(group, u, v, w = W, h = H) {
  return groupWeight(prepareGroup(group, w, h), u * w, v * h);
}

/** @param {import("../mask-math.js").Mask} mask */
function mw(mask, u, v, w = W, h = H) {
  return maskWeight(prepareMask(mask, w, h), u * w, v * h);
}

/** @param {import("../mask-math.js").MaskComponent[]} components */
function groupOf(...components) {
  const group = createMaskGroup(components[0]);
  group.components = [...components];
  return group;
}

/** @param {number[]} values @param {number} w @param {number} h */
function brushComponentFromGrid(values, w, h, mode = "add") {
  const c = createBrushComponent(w, h, mode);
  c.coverage = Uint8Array.from(values);
  return c;
}

// --- component factories ---

test("component factories carry mode and id, not adjustments or enabled", () => {
  const c = createLinearComponent(0.3, 0.4, "subtract");
  assert.equal(c.mode, "subtract");
  assert.equal(c.type, "linear");
  assert.ok(c.id.length > 0);
  assert.ok(!("adjustments" in c));
  assert.ok(!("enabled" in c));
  const c2 = createLinearComponent();
  assert.equal(c2.mode, "add");
  assert.notEqual(c.id, c2.id);
  const r = createRadialComponent(0.5, 0.5);
  assert.equal(r.radiusX, MASK.RADIAL_RADIUS[0]);
  const b = createBrushComponent(4, 3);
  assert.equal(b.coverage?.length, 12);
  assert.equal(b.coverageW, 4);
});

// --- single component ≡ legacy mask ---

test("a group of one add component matches the legacy mask weight", () => {
  const cases = [
    [
      { ...createLinearMask(0.4, 0.6), angle: 0.7, range: 0.15 },
      { ...createLinearComponent(0.4, 0.6), angle: 0.7, range: 0.15 },
    ],
    [
      { ...createRadialMask(0.6, 0.4), invert: true },
      { ...createRadialComponent(0.6, 0.4), invert: true },
    ],
  ];
  for (const [legacy, component] of cases) {
    const group = createMaskGroup(component);
    for (const [u, v] of SAMPLES) {
      assert.ok(
        Math.abs(gw(group, u, v) - mw(legacy, u, v)) < 1e-12,
        `${legacy.type} (${u}, ${v})`,
      );
    }
  }
});

test("a group of one brush component matches the legacy brush weight", () => {
  const grid = [0, 64, 128, 255];
  const legacy = createBrushMask(2, 2);
  legacy.coverage = Uint8Array.from(grid);
  const group = groupOf(brushComponentFromGrid(grid, 2, 2));
  for (const [u, v] of SAMPLES) {
    assert.ok(Math.abs(gw(group, u, v) - mw(legacy, u, v)) < 1e-12);
  }
});

// --- add composition (screen union) ---

test("overlapping adds combine as a screen, not a max", () => {
  // two identical linear ramps: each is 0.5 on the anchor line → 0.75
  const g = groupOf(
    createLinearComponent(0.5, 0.5),
    createLinearComponent(0.5, 0.5),
  );
  assert.ok(Math.abs(gw(g, 0.5, 0.5) - 0.75) < 1e-9);
  // fully-selected and empty regions are unchanged by the overlap
  assert.equal(gw(g, 0.5, 0), 1);
  assert.equal(gw(g, 0.5, 1), 0);
});

test("disjoint adds select both regions", () => {
  const a = {
    ...createRadialComponent(0.25, 0.5),
    feather: 0,
    radiusX: 0.1,
    radiusY: 0.1,
  };
  const b = {
    ...createRadialComponent(0.75, 0.5),
    feather: 0,
    radiusX: 0.1,
    radiusY: 0.1,
  };
  const g = groupOf(a, b);
  assert.equal(gw(g, 0.25, 0.5), 1);
  assert.equal(gw(g, 0.75, 0.5), 1);
  assert.equal(gw(g, 0.5, 0.02), 0);
});

test("component order does not matter", () => {
  const a = { ...createLinearComponent(0.4, 0.6), angle: 0.7 };
  const b = createRadialComponent(0.6, 0.4);
  const s = { ...createRadialComponent(0.5, 0.5), mode: "subtract" };
  const g1 = groupOf(a, s, b);
  const g2 = groupOf(b, a, s);
  for (const [u, v] of SAMPLES) {
    assert.ok(Math.abs(gw(g1, u, v) - gw(g2, u, v)) < 1e-12, `(${u}, ${v})`);
  }
});

// --- subtract ---

test("a hard subtract cuts a hole; the rest is untouched", () => {
  const full = brushComponentFromGrid([255, 255, 255, 255], 2, 2);
  const hole = {
    ...createRadialComponent(0.5, 0.5, "subtract"),
    feather: 0,
    radiusX: 0.2,
    radiusY: 0.2,
  };
  const g = groupOf(full, hole);
  assert.equal(gw(g, 0.5, 0.5), 0);
  assert.equal(gw(g, 0.05, 0.05), 1);
  // subtract listed first carves identically — no order rescue
  assert.equal(gw(groupOf(hole, full), 0.5, 0.5), 0);
});

test("a feathered subtract is a soft eraser (multiplies down)", () => {
  const full = brushComponentFromGrid([255, 255, 255, 255], 2, 2);
  // linear subtract: weight 0.5 on its anchor line, 1 at top, 0 at bottom
  const soft = createLinearComponent(0.5, 0.5, "subtract");
  const g = groupOf(full, soft);
  assert.ok(Math.abs(gw(g, 0.5, 0.5) - 0.5) < 1e-9);
  assert.equal(gw(g, 0.5, 0), 0);
  assert.equal(gw(g, 0.5, 1), 1);
});

test("a subtract brush erases a gradient without rasterizing it", () => {
  const grad = createLinearComponent(0.5, 0.5); // selects the top half
  const paint = brushComponentFromGrid([255, 0, 0, 0], 2, 2, "subtract");
  const g = groupOf(grad, paint);
  assert.equal(gw(g, 0.25, 0.25), 0); // painted over: cut
  assert.equal(gw(g, 0.75, 0.25), 1); // unpainted top: still selected
  // the gradient component itself is untouched and re-editable
  assert.equal(g.components[0].type, "linear");
  assert.equal(g.components[0].range, MASK.LINEAR_RANGE);
});

// --- intersect via subtract + invert ---

test("an inverted subtract intersects: composite = wA · wB", () => {
  const a = createRadialComponent(0.4, 0.5);
  const b = {
    ...createRadialComponent(0.6, 0.5),
    mode: "subtract",
    invert: true,
  };
  const g = groupOf(a, b);
  const maskA = createRadialMask(0.4, 0.5);
  const maskB = createRadialMask(0.6, 0.5);
  for (const [u, v] of SAMPLES) {
    const expected = mw(maskA, u, v) * mw(maskB, u, v);
    assert.ok(Math.abs(gw(g, u, v) - expected) < 1e-12, `(${u}, ${v})`);
  }
});

// --- group invert ---

test("group invert flips the composite", () => {
  const g = groupOf(createLinearComponent(0.4, 0.6), {
    ...createRadialComponent(0.5, 0.5),
    mode: "subtract",
  });
  const gi = { ...g, invert: true };
  for (const [u, v] of SAMPLES) {
    assert.ok(Math.abs(gw(g, u, v) + gw(gi, u, v) - 1) < 1e-12, `(${u}, ${v})`);
  }
});

// --- empty / subtract-only groups ---

test("a group with no add components selects nothing", () => {
  const empty = { ...createMaskGroup(createLinearComponent()), components: [] };
  assert.equal(gw(empty, 0.5, 0.5), 0);
  const subOnly = groupOf(createRadialComponent(0.5, 0.5, "subtract"));
  for (const [u, v] of SAMPLES) assert.equal(gw(subOnly, u, v), 0);
  // inverted empty selects everything — consistent algebra; the UI warns
  assert.equal(gw({ ...empty, invert: true }, 0.5, 0.5), 1);
});

// --- resolution independence ---

test("composite weight is resolution-independent (preview ↔ full-res)", () => {
  const grid = [];
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) grid.push(Math.round((x / 3) * 255));
  const g = groupOf(
    { ...createLinearComponent(0.4, 0.6), angle: 0.7, range: 0.15 },
    createRadialComponent(0.6, 0.4),
    brushComponentFromGrid(grid, 4, 4, "subtract"),
  );
  for (const [u, v] of SAMPLES) {
    const full = gw(g, u, v, 9504, 6336);
    const preview = gw(g, u, v, 1188, 792);
    assert.ok(Math.abs(full - preview) < 1e-9, `(${u}, ${v})`);
  }
});

// --- migration ---

test("maskGroupFromLegacy renders identically to the legacy mask", () => {
  const brush = createBrushMask(2, 2);
  brush.coverage = Uint8Array.from([0, 64, 128, 255]);
  const legacies = [
    { ...createLinearMask(0.4, 0.6), angle: 0.7, range: 0.15 },
    { ...createRadialMask(0.3, 0.3), invert: true },
    brush,
  ];
  for (const legacy of legacies) {
    const g = maskGroupFromLegacy(legacy);
    for (const [u, v] of SAMPLES) {
      assert.ok(
        Math.abs(gw(g, u, v) - mw(legacy, u, v)) < 1e-12,
        `${legacy.type} (${u}, ${v})`,
      );
    }
  }
});

test("maskGroupFromLegacy maps fields onto the group and component", () => {
  const legacy = {
    ...createRadialMask(0.3, 0.3),
    enabled: false,
    invert: true,
  };
  legacy.adjustments = { ...legacy.adjustments, exposure: 1.25 };
  const g = maskGroupFromLegacy(legacy);
  assert.equal(g.enabled, false);
  assert.equal(g.invert, false); // legacy invert lives on the component
  assert.equal(g.adjustments.exposure, 1.25);
  assert.notEqual(g.adjustments, legacy.adjustments); // copied, not shared
  assert.equal(g.components.length, 1);
  assert.equal(g.components[0].mode, "add");
  assert.equal(g.components[0].invert, true);
  assert.ok(g.id.length > 0 && g.components[0].id.length > 0);
});

test("maskGroupFromLegacy adopts the brush coverage raster", () => {
  const legacy = createBrushMask(3, 2);
  legacy.coverage = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  legacy.coverageVersion = 7;
  const g = maskGroupFromLegacy(legacy);
  const c = g.components[0];
  assert.equal(c.coverage, legacy.coverage); // ownership moves, no copy
  assert.equal(c.coverageW, 3);
  assert.equal(c.coverageH, 2);
  assert.equal(c.coverageVersion, 7);
});

// --- brush grid normalization (renderer texture-array invariant) ---

test("resampleCoverage keeps the rendered field within rounding", () => {
  // constant raster stays exactly constant at any grid
  const flat = resampleCoverage(
    Uint8Array.from([128, 128, 128, 128]),
    2,
    2,
    5,
    3,
  );
  assert.ok([...flat].every((v) => v === 128));

  // a horizontal ramp is linear in UV — re-gridding (including a finer
  // grid) keeps the sampled weight within byte rounding across the
  // interior. Only the half-texel clamp band at the frame edge may
  // legitimately shift (a finer grid has a narrower clamp margin).
  const grid = [];
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) grid.push(Math.round((x / 3) * 255));
  const before = brushComponentFromGrid(grid, 4, 4);
  const after = brushComponentFromGrid(
    [...resampleCoverage(Uint8Array.from(grid), 4, 4, 8, 8)],
    8,
    8,
  );
  for (const u of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    for (const v of [0.1, 0.5, 0.9]) {
      const a = mw(/** @type {any} */ (before), u, v);
      const b = mw(/** @type {any} */ (after), u, v);
      assert.ok(Math.abs(a - b) < 0.004, `(${u}, ${v}): ${a} vs ${b}`);
    }
  }
  // edge clamp band: bounded drift, no wild values
  for (const u of [0.02, 0.98]) {
    const a = mw(/** @type {any} */ (before), u, 0.5);
    const b = mw(/** @type {any} */ (after), u, 0.5);
    assert.ok(Math.abs(a - b) < 0.05, `edge (${u}): ${a} vs ${b}`);
  }
});

test("normalizeBrushGrids re-grids only mismatched brush rasters", () => {
  const frameW = 4000;
  const frameH = 3000;
  const dims = brushCoverageDims(frameW, frameH);
  const onGrid = createMaskGroup(createBrushComponent(dims.w, dims.h));
  const analytic = createMaskGroup(createRadialComponent(0.5, 0.5));
  // everything already on the frame grid → no-op
  assert.equal(normalizeBrushGrids([onGrid, analytic], frameW, frameH), null);

  // a brush saved under the rotated orientation carries a transposed grid
  const rotated = createMaskGroup(createBrushComponent(dims.h, dims.w));
  rotated.components[0].coverage?.fill(255);
  rotated.components[0].coverageVersion = 3;
  const next = normalizeBrushGrids([rotated, analytic], frameW, frameH);
  assert.ok(next);
  const c = next[0].components[0];
  assert.equal(c.coverageW, dims.w);
  assert.equal(c.coverageH, dims.h);
  assert.equal(c.coverage?.length, dims.w * dims.h);
  assert.equal(c.coverageVersion, 4); // renderer re-uploads the layer
  assert.ok([...(c.coverage ?? [])].every((v) => v === 255));
  // untouched groups keep identity (no needless GPU re-uploads) and the
  // source raster is not mutated
  assert.equal(next[1], analytic);
  assert.equal(rotated.components[0].coverageW, dims.h);
});

// --- effectiveMaskGroups ---

test("effectiveMaskGroups neutralizes disabled groups but keeps components", () => {
  const on = createMaskGroup(createRadialComponent(0.5, 0.5));
  on.adjustments = { ...on.adjustments, exposure: 1 };
  const off = { ...createMaskGroup(createLinearComponent()), enabled: false };
  off.adjustments = { ...off.adjustments, exposure: 2 };
  const s = effectiveMaskGroups({ ...ZERO_SETTINGS, masks: [off, on] });
  assert.equal(s.masks.length, 2);
  assert.deepEqual(s.masks[0].adjustments, ZERO_MASK_ADJUSTMENTS);
  assert.equal(s.masks[0].components[0].type, "linear");
  assert.equal(s.masks[1].adjustments.exposure, 1);
});

test("effectiveMaskGroups bypassAll neutralizes everything", () => {
  const on = createMaskGroup(createRadialComponent(0.5, 0.5));
  on.adjustments = { ...on.adjustments, exposure: 1 };
  const s = effectiveMaskGroups({ ...ZERO_SETTINGS, masks: [on] }, true);
  assert.deepEqual(s.masks[0].adjustments, ZERO_MASK_ADJUSTMENTS);
});

test("effectiveMaskGroups with no masks returns settings unchanged", () => {
  assert.equal(effectiveMaskGroups(ZERO_SETTINGS), ZERO_SETTINGS);
});

test("effectiveMaskGroups holds the shader bounds", () => {
  // more groups than MASK.MAX → sliced
  const many = Array.from({ length: MASK.MAX + 3 }, () =>
    createMaskGroup(createRadialComponent(0.5, 0.5)),
  );
  assert.equal(
    effectiveMaskGroups({ ...ZERO_SETTINGS, masks: many }).masks.length,
    MASK.MAX,
  );

  // more components than MASK.MAX_COMPONENTS → truncated, flat across groups
  const fat = groupOf(
    ...Array.from({ length: MASK.MAX_COMPONENTS + 4 }, () =>
      createRadialComponent(0.5, 0.5),
    ),
  );
  const s = effectiveMaskGroups({ ...ZERO_SETTINGS, masks: [fat] });
  assert.equal(s.masks[0].components.length, MASK.MAX_COMPONENTS);

  // more brush components than the layer budget → extra brushes dropped,
  // analytic components kept
  const brushes = Array.from({ length: MASK.MAX_BRUSH_COMPONENTS + 2 }, () =>
    brushComponentFromGrid([255], 1, 1),
  );
  const mixed = groupOf(...brushes, createRadialComponent(0.5, 0.5));
  const sb = effectiveMaskGroups({ ...ZERO_SETTINGS, masks: [mixed] });
  const kept = sb.masks[0].components;
  assert.equal(
    kept.filter((c) => c.type === "brush").length,
    MASK.MAX_BRUSH_COMPONENTS,
  );
  assert.equal(kept.filter((c) => c.type === "radial").length, 1);

  // an untouched active group is returned by reference
  const on = createMaskGroup(createRadialComponent(0.5, 0.5));
  assert.equal(
    effectiveMaskGroups({ ...ZERO_SETTINGS, masks: [on] }).masks[0],
    on,
  );
});
