import { ZERO_SETTINGS } from "./tone/tone-math.js";
import { ZERO_GEOMETRY } from "./tone/geometry.js";
import {
  ZERO_MASK_ADJUSTMENTS,
  maskGroupFromLegacy,
  newMaskId,
} from "./tone/mask-math.js";

const DB_NAME = "open-raw-editor";
const STORE_NAME = "edits";
/** Presets share the DB; see presets.js. Bumping DB_VERSION added this store. */
export const PRESET_STORE_NAME = "presets";
const DB_VERSION = 2;
/** v1: one shape per mask. v2: mask groups of add/subtract components. */
export const EDIT_SCHEMA_VERSION = 2;
export const MAX_EDIT_RECORDS = 100;
export const RETENTION_MONTHS = 6;

const SETTING_KEYS = Object.keys(ZERO_SETTINGS).filter((k) => k !== "masks");
const MASK_NUM_KEYS = [
  "x",
  "y",
  "angle",
  "range",
  "radiusX",
  "radiusY",
  "feather",
  "coverageW",
  "coverageH",
  "coverageVersion",
];
const MASK_BOOL_KEYS = ["enabled", "invert"];
const MASK_TYPES = new Set(["linear", "radial", "brush"]);
const MASK_MODES = new Set(["add", "subtract"]);

/** @param {number} now */
export function retentionCutoff(now = Date.now()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  return cutoff.getTime();
}

/** @param {ArrayBuffer | ArrayBufferView} bytes */
export async function hashBytes(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Browser crypto is unavailable");
  }
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const buffer = view.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return (
    "sha256:" +
    [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Fallback for non-secure dev origins where Web Crypto is unavailable.
 * @param {{ name: string, size: number, lastModified: number }} file
 */
export function metadataEditKey(file) {
  return [
    "file-meta",
    encodeURIComponent(file.name),
    String(file.size),
    String(file.lastModified),
  ].join(":");
}

/**
 * Prefer a content hash. Fall back to file metadata on non-secure dev
 * origins such as http://machine-name:5174/.
 * @param {{ name: string, size: number, lastModified: number }} file
 * @param {ArrayBuffer | ArrayBufferView} bytes
 */
export async function editKeyForFile(file, bytes) {
  try {
    return await hashBytes(bytes);
  } catch (err) {
    console.info(
      "using metadata edit key because content hashing failed:",
      err,
    );
    return metadataEditKey(file);
  }
}

/** @param {unknown} v @param {number} fallback */
function finite(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** @param {unknown} v */
function bool(v) {
  return v === true;
}

/** @param {unknown} v */
function cloneCoverage(v) {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v);
  return null;
}

/**
 * Field-by-field sanitized copy of a mask adjustment set.
 * @param {unknown} input
 * @returns {import("./tone/mask-math.js").MaskAdjustments}
 */
function cloneAdjustments(input) {
  const adjustments = { ...ZERO_MASK_ADJUSTMENTS };
  if (input && typeof input === "object") {
    const adj = /** @type {Record<string, unknown>} */ (input);
    const out = /** @type {Record<string, number>} */ (adjustments);
    const zero = /** @type {Record<string, number>} */ (ZERO_MASK_ADJUSTMENTS);
    for (const key of Object.keys(ZERO_MASK_ADJUSTMENTS)) {
      out[key] = finite(adj[key], zero[key]);
    }
  }
  return adjustments;
}

/**
 * Sanitize a legacy v1 single-shape mask — kept solely so version-1
 * records can be lifted into groups (see validateEditSnapshot).
 * @param {unknown} input
 * @returns {import("./tone/mask-math.js").Mask | null}
 */
export function cloneMask(input) {
  if (!input || typeof input !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (input);
  const type = typeof raw.type === "string" ? raw.type : "";
  if (!MASK_TYPES.has(type)) return null;

  /** @type {import("./tone/mask-math.js").Mask} */
  const mask = {
    type: /** @type {"linear" | "radial" | "brush"} */ (type),
    enabled: true,
    invert: false,
    x: 0.5,
    y: 0.5,
    angle: 0,
    range: 0,
    radiusX: 0,
    radiusY: 0,
    feather: 0,
    adjustments: cloneAdjustments(raw.adjustments),
  };
  const maskRecord = /** @type {Record<string, any>} */ (mask);
  for (const key of MASK_BOOL_KEYS) maskRecord[key] = bool(raw[key]);
  for (const key of MASK_NUM_KEYS) {
    if (key in raw) maskRecord[key] = finite(raw[key], maskRecord[key] ?? 0);
  }
  const coverage = cloneCoverage(raw.coverage);
  if (mask.type === "brush") {
    if (!coverage) return null;
    mask.coverage = coverage;
    mask.coverageW = Math.max(1, Math.round(mask.coverageW ?? 1));
    mask.coverageH = Math.max(1, Math.round(mask.coverageH ?? 1));
    mask.coverageVersion = Math.max(0, Math.round(mask.coverageVersion ?? 0));
    // a raster whose length disagrees with its dims would read out of
    // bounds on the CPU and upload garbage on the GPU
    if (coverage.length !== mask.coverageW * mask.coverageH) return null;
  }
  return mask;
}

/**
 * Sanitize one shape component of a mask group.
 * @param {unknown} input
 * @returns {import("./tone/mask-math.js").MaskComponent | null}
 */
export function cloneComponent(input) {
  if (!input || typeof input !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (input);
  const type = typeof raw.type === "string" ? raw.type : "";
  if (!MASK_TYPES.has(type)) return null;

  /** @type {import("./tone/mask-math.js").MaskComponent} */
  const component = {
    id: typeof raw.id === "string" && raw.id ? raw.id : newMaskId(),
    mode: MASK_MODES.has(/** @type {string} */ (raw.mode))
      ? /** @type {"add" | "subtract"} */ (raw.mode)
      : "add",
    type: /** @type {"linear" | "radial" | "brush"} */ (type),
    invert: bool(raw.invert),
    x: 0.5,
    y: 0.5,
    angle: 0,
    range: 0,
    radiusX: 0,
    radiusY: 0,
    feather: 0,
  };
  const rec = /** @type {Record<string, any>} */ (component);
  for (const key of MASK_NUM_KEYS) {
    if (key in raw) rec[key] = finite(raw[key], rec[key] ?? 0);
  }
  if (component.type === "brush") {
    const coverage = cloneCoverage(raw.coverage);
    if (!coverage) return null;
    component.coverage = coverage;
    component.coverageW = Math.max(1, Math.round(component.coverageW ?? 1));
    component.coverageH = Math.max(1, Math.round(component.coverageH ?? 1));
    component.coverageVersion = Math.max(
      0,
      Math.round(component.coverageVersion ?? 0),
    );
    // a raster whose length disagrees with its dims would read out of
    // bounds on the CPU and upload garbage on the GPU
    if (coverage.length !== component.coverageW * component.coverageH)
      return null;
  }
  return component;
}

/**
 * Sanitize one mask group. A group with no valid components is dropped —
 * there is nothing it could render.
 * @param {unknown} input
 * @returns {import("./tone/mask-math.js").MaskGroup | null}
 */
export function cloneGroup(input) {
  if (!input || typeof input !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (input);
  const components = Array.isArray(raw.components)
    ? raw.components.map(cloneComponent).filter(Boolean)
    : [];
  if (components.length === 0) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newMaskId(),
    enabled: bool(raw.enabled),
    invert: bool(raw.invert),
    adjustments: cloneAdjustments(raw.adjustments),
    components: /** @type {import("./tone/mask-math.js").MaskComponent[]} */ (
      components
    ),
  };
}

/**
 * @param {unknown} input
 * @param {boolean} [legacyMasks] treat `masks` as v1 single shapes and lift
 *   each into a group of one add component (identical rendered result)
 * @returns {import("./tone/tone-math.js").ToneSettings}
 */
export function cloneSettings(input, legacyMasks = false) {
  const raw =
    input && typeof input === "object"
      ? /** @type {Record<string, unknown>} */ (input)
      : {};
  /** @type {import("./tone/tone-math.js").ToneSettings} */
  const settings = { ...ZERO_SETTINGS, masks: [] };
  const out = /** @type {Record<string, any>} */ (settings);
  const zero = /** @type {Record<string, number>} */ (
    /** @type {unknown} */ (ZERO_SETTINGS)
  );
  for (const key of SETTING_KEYS) out[key] = finite(raw[key], zero[key]);
  const rawMasks = Array.isArray(raw.masks) ? raw.masks : [];
  const masks = legacyMasks
    ? rawMasks
        .map(cloneMask)
        .filter((m) => m !== null)
        .map(maskGroupFromLegacy)
    : rawMasks.map(cloneGroup).filter(Boolean);
  settings.masks = /** @type {import("./tone/mask-math.js").MaskGroup[]} */ (
    masks
  );
  return settings;
}

/**
 * @param {{
 *   settings: import("./tone/tone-math.js").ToneSettings,
 *   cropRect: import("./tone/tone-math.js").CropRect,
 *   geometry: import("./tone/geometry.js").Geometry,
 *   panelBypassed: readonly string[],
 *   masksBypassed: boolean
 * }} state
 */
export function createEditSnapshot(state) {
  return {
    version: EDIT_SCHEMA_VERSION,
    settings: cloneSettings(state.settings),
    cropRect: {
      x: finite(state.cropRect.x, 0),
      y: finite(state.cropRect.y, 0),
      w: finite(state.cropRect.w, 1),
      h: finite(state.cropRect.h, 1),
    },
    geometry: {
      orient:
        Math.round(finite(state.geometry.orient, ZERO_GEOMETRY.orient)) & 3,
      angle: finite(state.geometry.angle, ZERO_GEOMETRY.angle),
      flipH: bool(state.geometry.flipH),
      flipV: bool(state.geometry.flipV),
    },
    panelBypassed: [
      ...new Set(state.panelBypassed.filter((v) => typeof v === "string")),
    ],
    masksBypassed: bool(state.masksBypassed),
  };
}

/** @param {unknown} input */
export function validateEditSnapshot(input) {
  if (!input || typeof input !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (input);
  const version = finite(raw.version, EDIT_SCHEMA_VERSION);
  // Version-1 snapshots migrate on load (their single-shape masks lift
  // into groups); anything newer than the current schema is rejected.
  if (version !== EDIT_SCHEMA_VERSION && version !== 1) return null;
  const cropRaw =
    raw.cropRect && typeof raw.cropRect === "object"
      ? /** @type {Record<string, unknown>} */ (raw.cropRect)
      : {};
  const geoRaw =
    raw.geometry && typeof raw.geometry === "object"
      ? /** @type {Record<string, unknown>} */ (raw.geometry)
      : {};
  return createEditSnapshot({
    settings: cloneSettings(raw.settings, version === 1),
    cropRect: {
      x: finite(cropRaw.x, 0),
      y: finite(cropRaw.y, 0),
      w: finite(cropRaw.w, 1),
      h: finite(cropRaw.h, 1),
    },
    geometry: {
      orient: finite(geoRaw.orient, 0),
      angle: finite(geoRaw.angle, 0),
      flipH: bool(geoRaw.flipH),
      flipV: bool(geoRaw.flipV),
    },
    panelBypassed: Array.isArray(raw.panelBypassed) ? raw.panelBypassed : [],
    masksBypassed: bool(raw.masksBypassed),
  });
}

/** @param {unknown} record */
export function validateEditRecord(record) {
  if (!record || typeof record !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (record);
  if (raw.version !== EDIT_SCHEMA_VERSION && raw.version !== 1) return null;
  const edit = validateEditSnapshot(raw.edit);
  if (!edit) return null;
  return {
    key: typeof raw.key === "string" ? raw.key : "",
    version: EDIT_SCHEMA_VERSION,
    updatedAt: finite(raw.updatedAt, 0),
    file: raw.file && typeof raw.file === "object" ? raw.file : {},
    edit,
  };
}

/**
 * @param {readonly { key: string, updatedAt: number }[]} records
 * @param {number} now
 * @param {number} maxRecords
 */
export function recordsToPrune(
  records,
  now = Date.now(),
  maxRecords = MAX_EDIT_RECORDS,
) {
  const cutoff = retentionCutoff(now);
  const sorted = [...records].sort((a, b) => a.updatedAt - b.updatedAt);
  const remove = new Set(
    sorted.filter((r) => r.updatedAt < cutoff).map((r) => r.key),
  );
  const kept = sorted.filter((r) => !remove.has(r.key));
  for (const record of kept.slice(0, Math.max(0, kept.length - maxRecords))) {
    remove.add(record.key);
  }
  return [...remove];
}

/** @template T @param {IDBRequest<T>} req */
export function requestPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {IDBTransaction} tx */
export function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Open the shared app database. Presets (presets.js) reuse this so both
 * modules open DB_NAME at the same DB_VERSION — opening one name at two
 * versions throws VersionError, so this is the single owner of the schema.
 * @returns {Promise<IDBDatabase>}
 */
export function openDb() {
  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is unavailable");
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Additive upgrade: each store is created only if missing, so v1 users
    // keep their `edits` and just gain `presets`.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(PRESET_STORE_NAME)) {
        const presets = db.createObjectStore(PRESET_STORE_NAME, {
          keyPath: "id",
        });
        presets.createIndex("updatedAt", "updatedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {IDBDatabase} db */
async function allRecords(db) {
  const tx = db.transaction(STORE_NAME, "readonly");
  const records = await requestPromise(tx.objectStore(STORE_NAME).getAll());
  await txDone(tx);
  return /** @type {any[]} */ (records);
}

/** @param {IDBDatabase} db @param {readonly string[]} keys */
async function deleteRecords(db, keys) {
  if (keys.length === 0) return;
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  for (const key of keys) store.delete(key);
  await txDone(tx);
}

/** @param {IDBDatabase} db */
async function pruneDb(db) {
  const records = await allRecords(db);
  await deleteRecords(
    db,
    recordsToPrune(
      records
        .filter((r) => r && typeof r.key === "string")
        .map((r) => ({ key: r.key, updatedAt: finite(r.updatedAt, 0) })),
    ),
  );
}

export async function pruneSavedEdits() {
  const db = await openDb();
  try {
    await pruneDb(db);
  } finally {
    db.close();
  }
}

/** @param {string} key */
export async function loadSavedEdit(key) {
  const db = await openDb();
  try {
    await pruneDb(db);
    const tx = db.transaction(STORE_NAME, "readonly");
    const record = await requestPromise(tx.objectStore(STORE_NAME).get(key));
    await txDone(tx);
    return validateEditRecord(record)?.edit ?? null;
  } finally {
    db.close();
  }
}

/**
 * @param {{
 *   key: string,
 *   file: { name: string, size: number, lastModified: number,
 *           width?: number, height?: number },
 *   edit: ReturnType<typeof createEditSnapshot>
 * }} input
 */
export async function saveEdit(input) {
  const db = await openDb();
  const record = {
    key: input.key,
    version: EDIT_SCHEMA_VERSION,
    updatedAt: Date.now(),
    file: input.file,
    edit: input.edit,
  };
  try {
    await pruneDb(db);
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      await txDone(tx);
    } catch (err) {
      await deleteRecords(
        db,
        recordsToPrune(
          (await allRecords(db))
            .filter((r) => r && typeof r.key === "string")
            .map((r) => ({ key: r.key, updatedAt: finite(r.updatedAt, 0) })),
          Date.now(),
          Math.floor(MAX_EDIT_RECORDS / 2),
        ),
      );
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      await txDone(tx);
      if (err instanceof Error)
        console.warn("saved edit after prune:", err.message);
    }
  } finally {
    db.close();
  }
}

/** @param {string} key */
export async function deleteSavedEdit(key) {
  const db = await openDb();
  try {
    await deleteRecords(db, [key]);
  } finally {
    db.close();
  }
}
