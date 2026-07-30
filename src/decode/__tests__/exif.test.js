import assert from "node:assert/strict";
import test from "node:test";

import { exifFromJpeg, exifFromHeic, heicPrimaries } from "../exif.js";
import { parseTiffExif } from "../dng.js";

// --- tiny builders ----------------------------------------------------------

/** @param {(number | string | Uint8Array)[]} parts */
function bytes(...parts) {
  /** @type {number[]} */
  const out = [];
  for (const p of parts) {
    if (typeof p === "string") {
      for (const c of p) out.push(c.charCodeAt(0));
    } else if (p instanceof Uint8Array) {
      out.push(...p);
    } else {
      out.push(p);
    }
  }
  return new Uint8Array(out);
}

/** @param {number} v */
const u16 = (v) => bytes((v >> 8) & 0xff, v & 0xff);
/** @param {number} v */
const u32 = (v) =>
  bytes((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);

/**
 * A little-endian TIFF with IFD0 (Make/Model/Orientation) and an EXIF IFD
 * (ISO, exposure, f-number, focal length). Offsets are laid out by hand:
 * header 8, IFD0 at 8, its heap after, then the EXIF IFD and its heap.
 */
function buildExifTiff() {
  /** @param {number} v */
  const le16 = (v) => bytes(v & 0xff, (v >> 8) & 0xff);
  /** @param {number} v */
  const le32 = (v) =>
    bytes(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  /** @param {number} tag @param {number} type @param {number} count
   *  @param {Uint8Array} value 4 bytes: inline value or heap offset */
  const entry = (tag, type, count, value) =>
    bytes(le16(tag), le16(type), le32(count), value);

  // IFD0: 4 entries, then next=0. Heap: MAKE string, then rationals for
  // the EXIF IFD go in its own heap.
  const ifd0Start = 8;
  const ifd0Size = 2 + 4 * 12 + 4;
  const makeOffset = ifd0Start + ifd0Size;
  const make = "SONYCAM\0"; // 8 bytes > 4 → heap
  const exifStart = makeOffset + make.length;
  const exifSize = 2 + 4 * 12 + 4;
  const exifHeap = exifStart + exifSize;

  return bytes(
    "II",
    le16(42),
    le32(ifd0Start),
    // IFD0
    le16(4),
    entry(271, 2, make.length, le32(makeOffset)), // Make
    entry(272, 2, 4, bytes("A7\0", 0)), // Model, inline
    entry(274, 3, 1, bytes(le16(6), le16(0))), // Orientation
    entry(34665, 4, 1, le32(exifStart)), // EXIF IFD pointer
    le32(0),
    make,
    // EXIF IFD
    le16(4),
    entry(33434, 5, 1, le32(exifHeap)), // ExposureTime 1/250
    entry(33437, 5, 1, le32(exifHeap + 8)), // FNumber 28/10
    entry(34855, 3, 1, bytes(le16(100), le16(0))), // ISO
    entry(37386, 5, 1, le32(exifHeap + 16)), // FocalLength 55/1
    le32(0),
    le32(1),
    le32(250),
    le32(28),
    le32(10),
    le32(55),
    le32(1),
  );
}

/** @param {Uint8Array} tiff */
function expectMeta(tiff) {
  const meta = parseTiffExif(tiff);
  assert.ok(meta);
  assert.equal(meta.make, "SONYCAM");
  assert.equal(meta.model, "A7");
  assert.equal(meta.orientation, 6);
  assert.equal(meta.iso, 100);
  assert.equal(meta.shutter, 1 / 250);
  assert.equal(meta.aperture, 2.8);
  assert.equal(meta.focalLen, 55);
  return meta;
}

/** ISOBMFF box: size + type + payload. */
/** @param {string} type @param {Uint8Array[]} payload */
function box(type, ...payload) {
  const size = 8 + payload.reduce((n, p) => n + p.length, 0);
  return bytes(u32(size), type, ...payload);
}

/** @param {string} type @param {number} version @param {Uint8Array[]} payload */
function fullbox(type, version, ...payload) {
  return box(type, bytes(version, 0, 0, 0), ...payload);
}

const FTYP = box("ftyp", bytes("heic"), u32(0), bytes("mif1"));

/**
 * ftyp + meta(iinf + iloc) + mdat(payload), with iloc pointing at the
 * payload's absolute offset. Two passes: sizes don't depend on the offset
 * value (fixed 4-byte fields), so build once with 0 and once for real.
 * @param {Uint8Array} itemPayload
 */
function buildHeic(itemPayload) {
  /** @param {number} offset */
  const build = (offset) => {
    const infe = fullbox("infe", 2, u16(1), u16(0), bytes("Exif"), bytes(0));
    const iinf = fullbox("iinf", 0, u16(1), infe);
    const iloc = fullbox(
      "iloc",
      0,
      bytes(0x44, 0), // offset_size 4, length_size 4, base_offset_size 0
      u16(1), // item_count
      u16(1), // item_ID
      u16(0), // data_reference_index
      u16(1), // extent_count
      u32(offset),
      u32(itemPayload.length),
    );
    const meta = fullbox("meta", 0, iinf, iloc);
    return { head: bytes(FTYP, meta), mdat: box("mdat", itemPayload) };
  };
  const probe = build(0);
  const offset = probe.head.length + 8; // mdat payload starts past its header
  const real = build(offset);
  return bytes(real.head, real.mdat);
}

// --- tests ------------------------------------------------------------------

test("parseTiffExif reads camera fields from a bare TIFF", () => {
  expectMeta(buildExifTiff());
});

test("exifFromJpeg finds the Exif APP1 behind other segments", () => {
  const tiff = buildExifTiff();
  const xmp = bytes("http://ns.adobe.com/xap/1.0/", 0, "<x/>");
  const exifPayload = bytes("Exif", 0, 0, tiff);
  const jpeg = bytes(
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    u16(2 + 4),
    "JFIF", // APP0
    0xff,
    0xe1,
    u16(2 + xmp.length),
    xmp, // APP1, but XMP
    0xff,
    0xe1,
    u16(2 + exifPayload.length),
    exifPayload, // APP1 Exif
    0xff,
    0xda, // SOS
  );
  const meta = exifFromJpeg(jpeg);
  assert.ok(meta);
  assert.equal(meta.model, "A7");
  assert.equal(meta.iso, 100);
});

test("exifFromJpeg returns null when there is no Exif segment", () => {
  const jpeg = bytes(0xff, 0xd8, 0xff, 0xda);
  assert.equal(exifFromJpeg(jpeg), null);
});

test("exifFromHeic walks meta/iinf/iloc to the Exif item", () => {
  const tiff = buildExifTiff();
  const heic = buildHeic(bytes(u32(0), tiff)); // u32 tiff-header offset
  const meta = exifFromHeic(heic);
  assert.ok(meta);
  assert.equal(meta.make, "SONYCAM");
  assert.equal(meta.shutter, 1 / 250);
});

test("exifFromHeic survives files without an Exif item", () => {
  const heic = bytes(FTYP, fullbox("meta", 0, fullbox("iinf", 0, u16(0))));
  assert.equal(exifFromHeic(heic), null);
});

test("heicPrimaries reads the nclx colr box", () => {
  const colr = box(
    "colr",
    bytes("nclx"),
    u16(12),
    u16(13),
    u16(6),
    bytes(0x80),
  );
  const heic = bytes(FTYP, fullbox("meta", 0, box("iprp", box("ipco", colr))));
  assert.equal(heicPrimaries(heic), 12);
});

test("heicPrimaries sniffs Display P3 out of an ICC colr box", () => {
  const name = bytes(
    ...Array.from("Display P3").flatMap((c) => [0, c.charCodeAt(0)]),
  );
  const colr = box("colr", bytes("prof"), new Uint8Array(40), name);
  const heic = bytes(FTYP, fullbox("meta", 0, box("iprp", box("ipco", colr))));
  assert.equal(heicPrimaries(heic), 12);
});

test("heicPrimaries returns 0 when undeclared", () => {
  assert.equal(heicPrimaries(FTYP), 0);
  const heic = bytes(FTYP, fullbox("meta", 0));
  assert.equal(heicPrimaries(heic), 0);
});
