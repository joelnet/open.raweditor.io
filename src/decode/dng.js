// Minimal TIFF/DNG structure parser, just deep enough to find the main raw
// image and the color tags needed to develop it outside LibRaw.
//
// Exists for one reason: DNG 1.7 files whose raw payload is JPEG XL
// compressed (Compression 52546) — what recent Samsung and Apple phone
// cameras write — are not decodable by libraw-wasm (LibRaw only reaches
// JXL through the Adobe DNG SDK, which the wasm build does not include).
// Those files are detected here and developed by src/decode/jxl-worker.js
// instead. Everything else keeps going through LibRaw untouched.
//
// Pure functions over an ArrayBuffer; no DOM, node:test-able.
//
// Classic TIFF only (magic 42, 32-bit offsets): no phone camera writes
// BigTIFF DNGs, and a BigTIFF file simply falls through to LibRaw.

/** DNG Compression value for JPEG XL payloads (DNG 1.7). */
export const COMPRESSION_JXL = 52546;

/** TIFF tag ids used below, named for readability. */
const TAG = {
  NEW_SUBFILE_TYPE: 254,
  IMAGE_WIDTH: 256,
  IMAGE_LENGTH: 257,
  BITS_PER_SAMPLE: 258,
  COMPRESSION: 259,
  PHOTOMETRIC: 262,
  MAKE: 271,
  MODEL: 272,
  STRIP_OFFSETS: 273,
  ORIENTATION: 274,
  SAMPLES_PER_PIXEL: 277,
  ROWS_PER_STRIP: 278,
  STRIP_BYTE_COUNTS: 279,
  SUB_IFDS: 330,
  TILE_WIDTH: 322,
  TILE_LENGTH: 323,
  TILE_OFFSETS: 324,
  TILE_BYTE_COUNTS: 325,
  SAMPLE_FORMAT: 339,
  EXIF_IFD: 34665,
  EXPOSURE_TIME: 33434,
  F_NUMBER: 33437,
  ISO_SPEED: 34855,
  FOCAL_LENGTH: 37386,
  DNG_VERSION: 50706,
  LINEARIZATION_TABLE: 50712,
  BLACK_LEVEL: 50714,
  WHITE_LEVEL: 50717,
  ACTIVE_AREA: 50829,
  SUB_TILE_BLOCK_SIZE: 50974,
  ROW_INTERLEAVE_FACTOR: 50975,
  COLUMN_INTERLEAVE_FACTOR: 52547,
  COLOR_MATRIX_1: 50721,
  COLOR_MATRIX_2: 50722,
  AS_SHOT_NEUTRAL: 50728,
  CALIBRATION_ILLUMINANT_1: 50778,
  CALIBRATION_ILLUMINANT_2: 50779,
};

/** @type {Record<number, number>} */
const TYPE_SIZES = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

/**
 * @typedef {{ tag: number, type: number, count: number, valueOffset: number }} RawEntry
 * @typedef {Map<number, RawEntry>} Ifd
 */

/**
 * @param {DataView} view
 * @param {boolean} le little-endian
 * @param {number} offset
 * @returns {{ entries: Ifd, next: number }}
 */
function readIfd(view, le, offset) {
  const entries = new Map();
  const n = view.getUint16(offset, le);
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12;
    entries.set(view.getUint16(e, le), {
      tag: view.getUint16(e, le),
      type: view.getUint16(e + 2, le),
      count: view.getUint32(e + 4, le),
      valueOffset: e + 8,
    });
  }
  return { entries, next: view.getUint32(offset + 2 + n * 12, le) };
}

/**
 * Read a tag's values as numbers (rationals become value = num/den).
 * @param {DataView} view
 * @param {boolean} le
 * @param {RawEntry | undefined} entry
 * @returns {number[] | null}
 */
function values(view, le, entry) {
  if (!entry) return null;
  const size = (TYPE_SIZES[entry.type] ?? 1) * entry.count;
  const base =
    size <= 4 ? entry.valueOffset : view.getUint32(entry.valueOffset, le);
  if (base + size > view.byteLength) return null;
  const out = [];
  for (let i = 0; i < entry.count; i++) {
    switch (entry.type) {
      case 1: // BYTE
      case 7: // UNDEFINED
        out.push(view.getUint8(base + i));
        break;
      case 3: // SHORT
        out.push(view.getUint16(base + i * 2, le));
        break;
      case 4: // LONG
        out.push(view.getUint32(base + i * 4, le));
        break;
      case 8: // SSHORT
        out.push(view.getInt16(base + i * 2, le));
        break;
      case 9: // SLONG
        out.push(view.getInt32(base + i * 4, le));
        break;
      case 5: {
        // RATIONAL
        const num = view.getUint32(base + i * 8, le);
        const den = view.getUint32(base + i * 8 + 4, le);
        out.push(den ? num / den : 0);
        break;
      }
      case 10: {
        // SRATIONAL
        const num = view.getInt32(base + i * 8, le);
        const den = view.getInt32(base + i * 8 + 4, le);
        out.push(den ? num / den : 0);
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

/**
 * @param {DataView} view
 * @param {boolean} le
 * @param {RawEntry | undefined} entry
 * @returns {string | null}
 */
function ascii(view, le, entry) {
  if (!entry || entry.type !== 2) return null;
  const base =
    entry.count <= 4
      ? entry.valueOffset
      : view.getUint32(entry.valueOffset, le);
  if (base + entry.count > view.byteLength) return null;
  let s = "";
  for (let i = 0; i < entry.count; i++) {
    const c = view.getUint8(base + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim() || null;
}

/**
 * Walk IFD0 plus its SubIFDs (one level — where DNG keeps the raw image)
 * and the EXIF IFD.
 * @param {DataView} view
 * @param {boolean} le
 * @returns {{ ifds: Ifd[], exif: Ifd | null }}
 */
function collectIfds(view, le) {
  const ifds = [];
  let exif = null;
  let offset = view.getUint32(4, le);
  // Chained top-level IFDs (rare in DNG, but cheap to follow), capped to
  // keep malformed files from looping forever.
  for (let hops = 0; offset && hops < 8; hops++) {
    if (offset + 2 > view.byteLength) break;
    const { entries, next } = readIfd(view, le, offset);
    ifds.push(entries);
    const sub = values(view, le, entries.get(TAG.SUB_IFDS));
    for (const s of sub ?? []) {
      if (s && s + 2 <= view.byteLength)
        ifds.push(readIfd(view, le, s).entries);
    }
    const exifOff = values(view, le, entries.get(TAG.EXIF_IFD))?.[0];
    if (!exif && exifOff && exifOff + 2 <= view.byteLength) {
      exif = readIfd(view, le, exifOff).entries;
    }
    offset = next;
  }
  return { ifds, exif };
}

/**
 * @typedef {{
 *   width: number, height: number,
 *   bitsPerSample: number, samplesPerPixel: number,
 *   sampleFormat: number, photometric: number,
 *   hasLinearizationTable: boolean,
 *   activeArea: number[] | null,
 *   subTileBlockSize: number[] | null,
 *   rowInterleaveFactor: number, columnInterleaveFactor: number,
 *   orientation: number,
 *   make: string, model: string,
 *   blackLevel: number[], whiteLevel: number[],
 *   asShotNeutral: number[] | null,
 *   colorMatrix1: number[] | null, colorMatrix2: number[] | null,
 *   calibrationIlluminant1: number, calibrationIlluminant2: number,
 *   exif: { iso: number, shutter: number, aperture: number, focalLen: number },
 *   tiles: { offset: number, byteCount: number, x: number, y: number }[],
 *   tileWidth: number, tileHeight: number,
 * }} JxlDng
 */

/**
 * Detect and describe a JXL-compressed DNG. Returns null for anything that
 * is not a TIFF, not JXL-compressed, or not a raw layout this pipeline can
 * develop (16-bit RGB LinearRaw in strips or tiles).
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {JxlDng | null}
 */
export function parseJxlDng(buffer) {
  const view =
    buffer instanceof Uint8Array
      ? new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new DataView(buffer);
  if (view.byteLength < 16) return null;
  const order = view.getUint16(0, false);
  const le = order === 0x4949; // "II"
  if (!le && order !== 0x4d4d) return null; // "MM"
  if (view.getUint16(2, le) !== 42) return null;

  const { ifds, exif } = collectIfds(view, le);
  if (!ifds.length) return null;
  const ifd0 = ifds[0];

  // The main image: NewSubfileType 0 (or the tag missing on the only IFD).
  const raw = ifds.find((ifd) => {
    const sub = values(view, le, ifd.get(TAG.NEW_SUBFILE_TYPE))?.[0] ?? 0;
    return sub === 0;
  });
  if (!raw) return null;

  const compression = values(view, le, raw.get(TAG.COMPRESSION))?.[0];
  if (compression !== COMPRESSION_JXL) return null;

  const width = values(view, le, raw.get(TAG.IMAGE_WIDTH))?.[0] ?? 0;
  const height = values(view, le, raw.get(TAG.IMAGE_LENGTH))?.[0] ?? 0;
  const bits = values(view, le, raw.get(TAG.BITS_PER_SAMPLE)) ?? [];
  const samples = values(view, le, raw.get(TAG.SAMPLES_PER_PIXEL))?.[0] ?? 1;
  if (!width || !height) return null;
  // Mixed per-channel bit depths would break WhiteLevel semantics.
  if (bits.some((b) => b !== bits[0])) return null;

  /** @type {JxlDng["tiles"]} */
  const tiles = [];
  let tileWidth = width;
  let tileHeight;
  const tileOffsets = values(view, le, raw.get(TAG.TILE_OFFSETS));
  if (tileOffsets) {
    tileWidth = values(view, le, raw.get(TAG.TILE_WIDTH))?.[0] ?? 0;
    tileHeight = values(view, le, raw.get(TAG.TILE_LENGTH))?.[0] ?? 0;
    const counts = values(view, le, raw.get(TAG.TILE_BYTE_COUNTS));
    if (!tileWidth || !tileHeight || !counts) return null;
    const across = Math.ceil(width / tileWidth);
    for (let i = 0; i < tileOffsets.length; i++) {
      tiles.push({
        offset: tileOffsets[i],
        byteCount: counts[i] ?? 0,
        x: (i % across) * tileWidth,
        y: Math.floor(i / across) * tileHeight,
      });
    }
  } else {
    const stripOffsets = values(view, le, raw.get(TAG.STRIP_OFFSETS));
    const counts = values(view, le, raw.get(TAG.STRIP_BYTE_COUNTS));
    const rowsPerStrip =
      values(view, le, raw.get(TAG.ROWS_PER_STRIP))?.[0] ?? height;
    if (!stripOffsets || !counts) return null;
    tileHeight = rowsPerStrip;
    for (let i = 0; i < stripOffsets.length; i++) {
      tiles.push({
        offset: stripOffsets[i],
        byteCount: counts[i] ?? 0,
        x: 0,
        y: i * rowsPerStrip,
      });
    }
  }
  if (!tiles.length) return null;

  const exifNum = (/** @type {number} */ tag) =>
    (exif ? values(view, le, exif.get(tag))?.[0] : 0) ?? 0;

  return {
    width,
    height,
    bitsPerSample: bits[0] ?? 16,
    samplesPerPixel: samples,
    sampleFormat: values(view, le, raw.get(TAG.SAMPLE_FORMAT))?.[0] ?? 1,
    photometric: values(view, le, raw.get(TAG.PHOTOMETRIC))?.[0] ?? 0,
    hasLinearizationTable: raw.has(TAG.LINEARIZATION_TABLE),
    activeArea: values(view, le, raw.get(TAG.ACTIVE_AREA)),
    subTileBlockSize: values(view, le, raw.get(TAG.SUB_TILE_BLOCK_SIZE)),
    rowInterleaveFactor:
      values(view, le, raw.get(TAG.ROW_INTERLEAVE_FACTOR))?.[0] ?? 1,
    columnInterleaveFactor:
      values(view, le, raw.get(TAG.COLUMN_INTERLEAVE_FACTOR))?.[0] ?? 1,
    orientation: values(view, le, ifd0.get(TAG.ORIENTATION))?.[0] ?? 1,
    make: ascii(view, le, ifd0.get(TAG.MAKE)) ?? "",
    model: ascii(view, le, ifd0.get(TAG.MODEL)) ?? "",
    blackLevel: values(view, le, raw.get(TAG.BLACK_LEVEL)) ?? [0],
    whiteLevel: values(view, le, raw.get(TAG.WHITE_LEVEL)) ?? [
      (1 << (bits[0] ?? 16)) - 1,
    ],
    asShotNeutral: values(view, le, ifd0.get(TAG.AS_SHOT_NEUTRAL)),
    colorMatrix1: values(view, le, ifd0.get(TAG.COLOR_MATRIX_1)),
    colorMatrix2: values(view, le, ifd0.get(TAG.COLOR_MATRIX_2)),
    calibrationIlluminant1:
      values(view, le, ifd0.get(TAG.CALIBRATION_ILLUMINANT_1))?.[0] ?? 0,
    calibrationIlluminant2:
      values(view, le, ifd0.get(TAG.CALIBRATION_ILLUMINANT_2))?.[0] ?? 0,
    exif: {
      iso: exifNum(TAG.ISO_SPEED),
      shutter: exifNum(TAG.EXPOSURE_TIME),
      aperture: exifNum(TAG.F_NUMBER),
      focalLen: exifNum(TAG.FOCAL_LENGTH),
    },
    tiles,
    tileWidth,
    tileHeight,
  };
}

/**
 * Cheap detection for the decode router: is this a DNG whose raw image is
 * JPEG XL compressed?
 * @param {ArrayBuffer | Uint8Array} buffer
 */
export function isJxlDng(buffer) {
  try {
    return parseJxlDng(buffer) !== null;
  } catch {
    return false;
  }
}
