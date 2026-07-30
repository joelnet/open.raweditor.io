// EXIF extraction for bitmap files. A JPEG's APP1 segment and a HEIC's
// Exif item both wrap the same TIFF structure, which parseTiffExif
// (dng.js) reads; this module just finds it. Also digs the colour
// primaries out of a HEIC's meta box, so the wasm decode path knows when
// its pixels are Display P3 rather than sRGB. Pure functions over bytes;
// no DOM, node:test-able.

import { parseTiffExif } from "./dng.js";

/** @typedef {ReturnType<typeof parseTiffExif>} ExifMeta */

/** @param {Uint8Array} bytes */
function toView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// --- JPEG ------------------------------------------------------------------

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"

/**
 * Walk the JPEG marker segments to the APP1 Exif payload.
 * @param {Uint8Array} bytes
 * @returns {ExifMeta}
 */
export function exifFromJpeg(bytes) {
  const view = toView(bytes);
  let off = 2; // past SOI
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) break;
    const marker = bytes[off + 1];
    if (marker === 0xff) {
      off++; // fill byte
      continue;
    }
    // Standalone markers (RSTn, TEM) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI: no EXIF past here
    const size = view.getUint16(off + 2, false);
    if (size < 2 || off + 2 + size > bytes.length) break;
    if (
      marker === 0xe1 && // APP1 — also used for XMP, so check the signature
      size >= 2 + EXIF_HEADER.length &&
      EXIF_HEADER.every((b, i) => bytes[off + 4 + i] === b)
    ) {
      return parseTiffExif(
        bytes.subarray(off + 4 + EXIF_HEADER.length, off + 2 + size),
      );
    }
    off += 2 + size;
  }
  return null;
}

// --- HEIC (ISOBMFF) --------------------------------------------------------

/** @param {DataView} view @param {number} off */
function fourcc(view, off) {
  return String.fromCharCode(
    view.getUint8(off),
    view.getUint8(off + 1),
    view.getUint8(off + 2),
    view.getUint8(off + 3),
  );
}

/**
 * Iterate the ISOBMFF boxes in [start, end).
 * @param {DataView} view
 * @param {number} start
 * @param {number} end
 * @returns {Generator<{ type: string, start: number, end: number }>}
 */
function* boxes(view, start, end) {
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off, false);
    const type = fourcc(view, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size =
        view.getUint32(off + 8, false) * 2 ** 32 +
        view.getUint32(off + 12, false);
      header = 16;
    } else if (size === 0) {
      size = end - off; // "to end of file"
    }
    if (size < header || off + size > end) return;
    yield { type, start: off + header, end: off + size };
    off += size;
  }
}

/**
 * @param {DataView} view
 * @param {number} start
 * @param {number} end
 * @param {string} type
 */
function findBox(view, start, end, type) {
  for (const box of boxes(view, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/** Read an unsigned int of 0, 4, or 8 bytes (the sizes iloc uses).
 * @param {DataView} view @param {number} off @param {number} size */
function readUint(view, off, size) {
  if (size === 0) return 0;
  if (size === 4) return view.getUint32(off, false);
  return view.getUint32(off, false) * 2 ** 32 + view.getUint32(off + 4, false);
}

/**
 * Locate the Exif item's payload via meta → iinf (item id) → iloc (byte
 * range). Only construction method 0 (absolute file offset) is handled —
 * what cameras write.
 * @param {DataView} view
 * @param {Uint8Array} bytes
 * @returns {Uint8Array | null}
 */
function heicExifPayload(view, bytes) {
  const meta = findBox(view, 0, view.byteLength, "meta");
  if (!meta) return null;
  const inner = { start: meta.start + 4, end: meta.end }; // meta is a FullBox

  const iinf = findBox(view, inner.start, inner.end, "iinf");
  if (!iinf) return null;
  const iinfVersion = view.getUint8(iinf.start);
  const countSize = iinfVersion === 0 ? 2 : 4;
  let exifId = -1;
  for (const box of boxes(view, iinf.start + 4 + countSize, iinf.end)) {
    if (box.type !== "infe") continue;
    const v = view.getUint8(box.start);
    if (v < 2) continue; // pre-HEIF infe carries no item_type
    const id =
      v === 2
        ? view.getUint16(box.start + 4, false)
        : view.getUint32(box.start + 4, false);
    const typeOff = box.start + 4 + (v === 2 ? 4 : 6);
    if (fourcc(view, typeOff) === "Exif") {
      exifId = id;
      break;
    }
  }
  if (exifId < 0) return null;

  const iloc = findBox(view, inner.start, inner.end, "iloc");
  if (!iloc) return null;
  const v = view.getUint8(iloc.start);
  let off = iloc.start + 4;
  const offsetSize = view.getUint8(off) >> 4;
  const lengthSize = view.getUint8(off) & 0xf;
  const baseOffsetSize = view.getUint8(off + 1) >> 4;
  const indexSize = v === 1 || v === 2 ? view.getUint8(off + 1) & 0xf : 0;
  off += 2;
  const itemCount =
    v < 2 ? view.getUint16(off, false) : view.getUint32(off, false);
  off += v < 2 ? 2 : 4;
  for (let i = 0; i < itemCount; i++) {
    const id = v < 2 ? view.getUint16(off, false) : view.getUint32(off, false);
    off += v < 2 ? 2 : 4;
    let method = 0;
    if (v === 1 || v === 2) {
      method = view.getUint16(off, false) & 0xf;
      off += 2;
    }
    off += 2; // data_reference_index
    const baseOffset = readUint(view, off, baseOffsetSize);
    off += baseOffsetSize;
    const extentCount = view.getUint16(off, false);
    off += 2;
    if (id !== exifId) {
      off += extentCount * (indexSize + offsetSize + lengthSize);
      continue;
    }
    if (method !== 0 || extentCount < 1) return null;
    const extentOffset = readUint(view, off + indexSize, offsetSize);
    const extentLength = readUint(
      view,
      off + indexSize + offsetSize,
      lengthSize,
    );
    const start = baseOffset + extentOffset;
    if (extentLength < 8 || start + extentLength > bytes.length) return null;
    return bytes.subarray(start, start + extentLength);
  }
  return null;
}

/**
 * @param {Uint8Array} bytes
 * @returns {ExifMeta}
 */
export function exifFromHeic(bytes) {
  const view = toView(bytes);
  const payload = heicExifPayload(view, bytes);
  if (!payload) return null;
  // The item starts with a u32 offset to the TIFF header.
  const tiffOffset = readUint(toView(payload), 0, 4);
  if (4 + tiffOffset + 8 > payload.length) return null;
  return parseTiffExif(payload.subarray(4 + tiffOffset));
}

/** CICP colour primaries value for Display P3. */
export const PRIMARIES_P3 = 12;

/** "Display P3" as UTF-16BE — how an ICC profile's description tag spells
 * it. */
const P3_UTF16 = Array.from("Display P3").flatMap((c) => [0, c.charCodeAt(0)]);

/**
 * The image's colour primaries: a CICP code from the first nclx colr box
 * (12 = Display P3), PRIMARIES_P3 for an ICC profile that describes
 * itself as Display P3, or 0 when undeclared (assume sRGB).
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function heicPrimaries(bytes) {
  const view = toView(bytes);
  const meta = findBox(view, 0, view.byteLength, "meta");
  if (!meta) return 0;
  const iprp = findBox(view, meta.start + 4, meta.end, "iprp");
  if (!iprp) return 0;
  const ipco = findBox(view, iprp.start, iprp.end, "ipco");
  if (!ipco) return 0;
  // First colr wins: properties for the primary image come first in
  // practice, and auxiliary images share its colour space anyway.
  for (const box of boxes(view, ipco.start, ipco.end)) {
    if (box.type !== "colr" || box.end - box.start < 4) continue;
    const colourType = fourcc(view, box.start);
    if (colourType === "nclx" && box.end - box.start >= 6) {
      return view.getUint16(box.start + 4, false);
    }
    if (colourType === "prof" || colourType === "rICC") {
      const icc = bytes.subarray(box.start + 4, box.end);
      for (let i = 0; i + P3_UTF16.length <= icc.length; i++) {
        if (P3_UTF16.every((b, j) => icc[i + j] === b)) return PRIMARIES_P3;
      }
      return 0;
    }
  }
  return 0;
}
