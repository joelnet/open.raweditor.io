import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneLook,
  createPreset,
  exportPresetsJson,
  parsePresetsJson,
  uniqueName,
  validatePresetRecord,
} from "../presets.js";
import { EDIT_SCHEMA_VERSION } from "../edit-persistence.js";
import { ZERO_SETTINGS } from "../tone/tone-math.js";
import { createBrushMask } from "../tone/mask-math.js";

test("cloneLook strips masks and fills missing keys from ZERO_SETTINGS", () => {
  const brush = createBrushMask(2, 2);
  const look = cloneLook({ exposure: 0.5, contrast: 0.2, masks: [brush] });

  assert.equal(look.exposure, 0.5);
  assert.equal(look.contrast, 0.2);
  assert.equal(look.shadows, ZERO_SETTINGS.shadows); // unspecified -> neutral
  assert.deepEqual(look.masks, []); // local masks never travel in a preset
});

test("createPreset trims/defaults the name and produces a v1 look", () => {
  const named = createPreset({
    name: "  Warm Film  ",
    settings: { temp: 0.3 },
  });
  assert.equal(named.name, "Warm Film");
  assert.equal(named.version, EDIT_SCHEMA_VERSION);
  assert.equal(named.settings.temp, 0.3);
  assert.deepEqual(named.settings.masks, []);
  assert.match(named.id, /^preset:/);
  assert.ok(named.updatedAt > 0);

  const blank = createPreset({ name: "   ", settings: {} });
  assert.equal(blank.name, "Preset");
});

test("validatePresetRecord is lenient on version and sanitizes settings", () => {
  // A record saved under a future schema version must NOT be discarded
  // (presets are user-authored and precious, unlike per-file edits).
  const restored = validatePresetRecord({
    id: "preset:x",
    name: "Future",
    version: EDIT_SCHEMA_VERSION + 99,
    updatedAt: 1234,
    settings: { exposure: 1.5, bogusKey: 7, masks: ["junk"] },
  });

  assert.ok(restored);
  assert.equal(restored.version, EDIT_SCHEMA_VERSION);
  assert.equal(restored.settings.exposure, 1.5);
  assert.equal(restored.settings.contrast, ZERO_SETTINGS.contrast);
  assert.equal(/** @type {any} */ (restored.settings).bogusKey, undefined);
  assert.deepEqual(restored.settings.masks, []);
  assert.equal(restored.updatedAt, 1234);
});

test("validatePresetRecord rejects only structurally unusable records", () => {
  assert.equal(validatePresetRecord(null), null);
  assert.equal(validatePresetRecord("nope"), null);
  assert.equal(validatePresetRecord({ name: "no id" }), null);
});

test("uniqueName suffixes duplicate display names", () => {
  assert.equal(uniqueName("Preset", []), "Preset");
  assert.equal(uniqueName("Preset", ["Preset"]), "Preset 2");
  assert.equal(uniqueName("Preset", ["Preset", "Preset 2"]), "Preset 3");
  assert.equal(uniqueName("  ", ["Preset"]), "Preset 2"); // blank -> "Preset"
});

test("presets round-trip through export/parse with fresh ids", () => {
  const record = createPreset({ name: "Punch", settings: { contrast: 0.25 } });
  const json = exportPresetsJson([record]);
  assert.match(json, /open-raw-editor\/presets/);

  const parsed = parsePresetsJson(json);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, "Punch");
  assert.equal(parsed[0].settings.contrast, 0.25);
  assert.notEqual(parsed[0].id, record.id); // fresh id so import never clobbers
});

test("parsePresetsJson accepts a bare array and drops junk; bad JSON -> []", () => {
  const fromArray = parsePresetsJson(
    JSON.stringify([
      { id: "preset:a", name: "A", settings: { saturation: -1 } },
      { name: "no id, dropped" },
      "garbage",
    ]),
  );
  assert.equal(fromArray.length, 1);
  assert.equal(fromArray[0].name, "A");
  assert.equal(fromArray[0].settings.saturation, -1);

  assert.deepEqual(parsePresetsJson("{not json"), []);
});
