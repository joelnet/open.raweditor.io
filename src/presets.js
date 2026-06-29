// Presets: named, file-AGNOSTIC "looks" — the global tone/color adjustments
// saved once and applied to any image. Distinct from the per-file autosave in
// edit-persistence.js (which keys edits to a file's content hash). A preset is
// a constrained edit snapshot: the full scalar ToneSettings with `masks`,
// crop, and geometry deliberately stripped, since those are image-specific.
//
// Storage reuses the same IndexedDB database (a `presets` object store, see
// PRESET_STORE_NAME and openDb in edit-persistence.js). Validation reuses
// cloneSettings, so a preset stays forward/backward compatible: keys added to
// the model later default to ZERO_SETTINGS, keys removed are simply dropped.

import {
  EDIT_SCHEMA_VERSION,
  PRESET_STORE_NAME,
  cloneSettings,
  openDb,
  requestPromise,
  txDone,
} from "./edit-persistence.js";

/** @typedef {import("./tone/tone-math.js").ToneSettings} ToneSettings */
/**
 * @typedef {{ id: string, name: string, version: number,
 *             updatedAt: number, settings: ToneSettings }} PresetRecord
 */

const NAME_MAX = 60;

/** @param {unknown} v @param {number} fallback */
function finite(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** @param {unknown} name */
function normalizeName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return (trimmed || "Preset").slice(0, NAME_MAX);
}

function newId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `preset:${uuid}`;
  // Fallback for non-secure dev origins where crypto is unavailable, mirroring
  // metadataEditKey's philosophy in edit-persistence.js.
  return `preset:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Reduce any settings object to a portable look: a fully-sanitized
 * ToneSettings (missing keys filled from ZERO_SETTINGS) with local masks
 * stripped. Presets never carry masks — a brush coverage bitmap or a radial
 * over a face is meaningless on another photo.
 * @param {unknown} settings
 * @returns {ToneSettings}
 */
export function cloneLook(settings) {
  const look = cloneSettings(settings);
  look.masks = [];
  return look;
}

/**
 * @param {{ name?: string, settings: unknown, id?: string }} input
 * @returns {PresetRecord}
 */
export function createPreset(input) {
  return {
    id: input.id || newId(),
    name: normalizeName(input.name),
    version: EDIT_SCHEMA_VERSION,
    updatedAt: Date.now(),
    settings: cloneLook(input.settings),
  };
}

/**
 * Lenient validator: unlike validateEditRecord, a version mismatch never
 * discards the preset — user-authored presets are precious, so we always run
 * the payload through cloneLook and keep it. Returns null only for structurally
 * unusable records (no id).
 * @param {unknown} input
 * @returns {PresetRecord | null}
 */
export function validatePresetRecord(input) {
  if (!input || typeof input !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (input);
  if (typeof raw.id !== "string" || !raw.id) return null;
  return {
    id: raw.id,
    name: normalizeName(raw.name),
    version: EDIT_SCHEMA_VERSION,
    updatedAt: finite(raw.updatedAt, 0),
    settings: cloneLook(raw.settings),
  };
}

/**
 * Pick a display name not already used in `existingNames`, suffixing " 2",
 * " 3" … on collision. Records are id-keyed so duplicate names are allowed;
 * this just keeps the pill strip readable.
 * @param {string} name
 * @param {readonly string[]} existingNames
 */
export function uniqueName(name, existingNames) {
  const base = normalizeName(name);
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`.slice(0, NAME_MAX);
    if (!taken.has(candidate)) return candidate;
  }
}

/** @returns {Promise<PresetRecord[]>} newest first */
export async function listPresets() {
  const db = await openDb();
  try {
    const tx = db.transaction(PRESET_STORE_NAME, "readonly");
    const rows = await requestPromise(
      tx.objectStore(PRESET_STORE_NAME).getAll(),
    );
    await txDone(tx);
    return /** @type {unknown[]} */ (rows)
      .map(validatePresetRecord)
      .filter(/** @returns {p is PresetRecord} */ (p) => p !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

/** @param {PresetRecord} record */
export async function savePreset(record) {
  const db = await openDb();
  try {
    const tx = db.transaction(PRESET_STORE_NAME, "readwrite");
    tx.objectStore(PRESET_STORE_NAME).put(record);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** @param {string} id */
export async function deletePreset(id) {
  const db = await openDb();
  try {
    const tx = db.transaction(PRESET_STORE_NAME, "readwrite");
    tx.objectStore(PRESET_STORE_NAME).delete(id);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/**
 * Serialize presets to a portable JSON document (for backup / moving between
 * browsers — presets otherwise live only in this browser's IndexedDB).
 * @param {readonly PresetRecord[]} records
 */
export function exportPresetsJson(records) {
  const presets = records
    .map(validatePresetRecord)
    .filter(/** @returns {p is PresetRecord} */ (p) => p !== null);
  return JSON.stringify(
    { kind: "open-raw-editor/presets", version: EDIT_SCHEMA_VERSION, presets },
    null,
    2,
  );
}

/**
 * Parse an exported document (or a bare array) into validated presets with
 * fresh ids, so importing never clobbers an existing preset. Returns [] on
 * malformed JSON. Callers should de-duplicate names against the current set.
 * @param {string} text
 * @returns {PresetRecord[]}
 */
export function parsePresetsJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = /** @type {unknown[]} */ (
    Array.isArray(data)
      ? data
      : Array.isArray(data?.presets)
        ? data.presets
        : []
  );
  return arr
    .map(validatePresetRecord)
    .filter(/** @returns {p is PresetRecord} */ (p) => p !== null)
    .map((p) => ({ ...p, id: newId(), updatedAt: Date.now() }));
}
