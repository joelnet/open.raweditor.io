import assert from "node:assert/strict";
import test from "node:test";

import {
  EDIT_SCHEMA_VERSION,
  createEditSnapshot,
  metadataEditKey,
  recordsToPrune,
  retentionCutoff,
  validateEditRecord,
  validateEditSnapshot,
} from "../edit-persistence.js";
import { ZERO_SETTINGS } from "../tone/tone-math.js";
import {
  createBrushComponent,
  createBrushMask,
  createLinearComponent,
  createLinearMask,
  createMaskGroup,
  createRadialComponent,
} from "../tone/mask-math.js";

test("edit snapshots round-trip settings, crop, bypasses, and brush coverage", () => {
  const linear = createMaskGroup(createLinearComponent(0.25, 0.75));
  linear.adjustments.exposure = 1.25;
  const compound = createMaskGroup(createRadialComponent(0.5, 0.5));
  compound.invert = true;
  compound.adjustments.texture = 0.4;
  const brushComp = createBrushComponent(4, 2, "subtract");
  brushComp.coverage?.set([0, 32, 64, 96, 128, 160, 192, 255]);
  brushComp.coverageVersion = 7;
  compound.components = [...compound.components, brushComp];

  const snapshot = createEditSnapshot({
    settings: {
      ...ZERO_SETTINGS,
      exposure: 0.5,
      gradeBlending: 0.8,
      masks: [linear, compound],
    },
    cropRect: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 },
    geometry: { orient: 1, angle: -2.5, flipH: true, flipV: false },
    panelBypassed: ["TONE", "TONE", "EFFECTS"],
    masksBypassed: true,
  });
  const restored = validateEditSnapshot(snapshot);

  assert.equal(snapshot.version, EDIT_SCHEMA_VERSION);
  assert.equal(restored.version, EDIT_SCHEMA_VERSION);
  assert.equal(restored.settings.exposure, 0.5);
  assert.equal(restored.settings.gradeBlending, 0.8);
  assert.deepEqual(restored.cropRect, { x: 0.1, y: 0.2, w: 0.7, h: 0.6 });
  assert.deepEqual(restored.geometry, {
    orient: 1,
    angle: -2.5,
    flipH: true,
    flipV: false,
  });
  assert.deepEqual(restored.panelBypassed, ["TONE", "EFFECTS"]);
  assert.equal(restored.masksBypassed, true);
  assert.equal(restored.settings.masks.length, 2);
  assert.equal(restored.settings.masks[0].adjustments.exposure, 1.25);
  assert.equal(restored.settings.masks[0].components[0].type, "linear");
  const g = restored.settings.masks[1];
  assert.equal(g.invert, true);
  assert.equal(g.adjustments.texture, 0.4);
  assert.equal(g.components.length, 2);
  assert.equal(g.components[0].type, "radial");
  assert.equal(g.components[1].mode, "subtract");
  // stable ids survive the round-trip (GPU layer + selection identity)
  assert.equal(g.id, compound.id);
  assert.equal(g.components[1].id, brushComp.id);
  assert.deepEqual(
    [...(g.components[1].coverage ?? [])],
    [0, 32, 64, 96, 128, 160, 192, 255],
  );
  assert.notEqual(g.components[1].coverage, brushComp.coverage);
});

test("version-1 edits migrate: single-shape masks lift into groups", () => {
  const linear = createLinearMask(0.25, 0.75);
  linear.invert = true;
  linear.adjustments.exposure = 1.25;
  const brush = createBrushMask(4, 2);
  brush.coverage?.set([0, 32, 64, 96, 128, 160, 192, 255]);
  const v1 = {
    version: 1,
    settings: { ...ZERO_SETTINGS, exposure: 0.5, masks: [linear, brush] },
    cropRect: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 },
    geometry: { orient: 0, angle: 0, flipH: false, flipV: false },
    panelBypassed: [],
    masksBypassed: false,
  };
  const restored = validateEditSnapshot(v1);

  assert.equal(restored.version, EDIT_SCHEMA_VERSION);
  assert.equal(restored.settings.exposure, 0.5);
  assert.equal(restored.settings.masks.length, 2);
  const g = restored.settings.masks[0];
  assert.equal(g.enabled, true);
  assert.equal(g.invert, false); // legacy invert lives on the component
  assert.equal(g.adjustments.exposure, 1.25);
  assert.equal(g.components.length, 1);
  assert.equal(g.components[0].mode, "add");
  assert.equal(g.components[0].invert, true);
  assert.equal(g.components[0].x, 0.25);
  assert.equal(g.components[0].y, 0.75);
  const b = restored.settings.masks[1].components[0];
  assert.equal(b.type, "brush");
  assert.deepEqual(
    [...(b.coverage ?? [])],
    [0, 32, 64, 96, 128, 160, 192, 255],
  );

  // a version-1 *record* is accepted and re-stamped at the current schema
  const record = validateEditRecord({
    key: "sha256:a",
    version: 1,
    updatedAt: 123,
    file: {},
    edit: v1,
  });
  assert.ok(record);
  assert.equal(record.version, EDIT_SCHEMA_VERSION);
});

test("brush rasters with mismatched dimensions are dropped", () => {
  const good = createMaskGroup(createBrushComponent(2, 2));
  good.components[0].coverage?.fill(1);
  const bad = createMaskGroup(createBrushComponent(2, 2));
  bad.components[0].coverageW = 4; // dims lie about the 4-byte raster
  const snapshot = createEditSnapshot({
    settings: { ...ZERO_SETTINGS, masks: [good, bad] },
    cropRect: { x: 0, y: 0, w: 1, h: 1 },
    geometry: { orient: 0, angle: 0, flipH: false, flipV: false },
    panelBypassed: [],
    masksBypassed: false,
  });
  assert.equal(snapshot.settings.masks.length, 1);
  assert.equal(snapshot.settings.masks[0].id, good.id);

  // legacy v1 masks get the same check during migration
  const legacy = createBrushMask(2, 2);
  legacy.coverageW = 4;
  const restored = validateEditSnapshot({
    version: 1,
    settings: { ...ZERO_SETTINGS, masks: [legacy] },
    cropRect: { x: 0, y: 0, w: 1, h: 1 },
    geometry: { orient: 0, angle: 0, flipH: false, flipV: false },
    panelBypassed: [],
    masksBypassed: false,
  });
  assert.equal(restored.settings.masks.length, 0);
});

test("edit record validation rejects unsupported schema versions", () => {
  const edit = createEditSnapshot({
    settings: { ...ZERO_SETTINGS },
    cropRect: { x: 0, y: 0, w: 1, h: 1 },
    geometry: { orient: 0, angle: 0, flipH: false, flipV: false },
    panelBypassed: [],
    masksBypassed: false,
  });

  assert.equal(
    validateEditRecord({
      key: "sha256:a",
      version: EDIT_SCHEMA_VERSION + 1,
      updatedAt: Date.now(),
      file: {},
      edit,
    }),
    null,
  );
  assert.equal(
    validateEditRecord({
      key: "sha256:a",
      version: EDIT_SCHEMA_VERSION,
      updatedAt: Date.now(),
      file: {},
      edit: { ...edit, version: EDIT_SCHEMA_VERSION + 1 },
    }),
    null,
  );
});

test("metadataEditKey is stable for the same file metadata", () => {
  assert.equal(
    metadataEditKey({ name: "same file.dng", size: 123, lastModified: 456 }),
    "file-meta:same%20file.dng:123:456",
  );
});

test("recordsToPrune deletes edits older than six months and caps count", () => {
  const now = new Date(2026, 5, 17, 12).getTime();
  const cutoff = retentionCutoff(now);
  assert.equal(cutoff, new Date(2025, 11, 17, 12).getTime());

  const records = [
    { key: "too-old", updatedAt: cutoff - 1 },
    { key: "at-cutoff", updatedAt: cutoff },
    ...Array.from({ length: 99 }, (_, i) => ({
      key: `recent-${i}`,
      updatedAt: cutoff + 1 + i,
    })),
  ];
  const pruned = recordsToPrune(records, now, 100).sort();

  assert(pruned.includes("too-old"));
  assert(!pruned.includes("at-cutoff"));
  assert.equal(pruned.length, 1);

  const capped = recordsToPrune(
    Array.from({ length: 101 }, (_, i) => ({
      key: `capped-${i}`,
      updatedAt: cutoff + i,
    })),
    now,
    100,
  );
  assert.deepEqual(capped, ["capped-0"]);
});
