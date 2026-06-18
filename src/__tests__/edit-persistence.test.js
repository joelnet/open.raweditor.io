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
import { createBrushMask, createLinearMask } from "../tone/mask-math.js";

test("edit snapshots round-trip settings, crop, bypasses, and brush coverage", () => {
  const linear = createLinearMask(0.25, 0.75);
  linear.adjustments.exposure = 1.25;
  const brush = createBrushMask(4, 2);
  brush.coverage?.set([0, 32, 64, 96, 128, 160, 192, 255]);
  brush.coverageVersion = 7;
  brush.adjustments.texture = 0.4;

  const snapshot = createEditSnapshot({
    settings: {
      ...ZERO_SETTINGS,
      exposure: 0.5,
      gradeBlending: 0.8,
      masks: [linear, brush],
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
  assert.equal(restored.settings.masks[1].type, "brush");
  assert.deepEqual(
    [...(restored.settings.masks[1].coverage ?? [])],
    [0, 32, 64, 96, 128, 160, 192, 255],
  );
  assert.notEqual(restored.settings.masks[1].coverage, brush.coverage);
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
