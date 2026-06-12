// Minimal TIFF writer for the export worker: uncompressed 16-bit RGB,
// single strip. Browsers can't encode TIFF via canvas, and 16-bit output is
// the point of the format here, so the container is assembled by hand.
// Byte order follows the platform so the strip can be bulk-copied as a
// Uint16Array; the header declares "II" or "MM" to match.

// IFD entry field types.
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;

const HEADER_BYTES = 8;
const ENTRY_BYTES = 12;

/**
 * Encode RGBA16 samples as an uncompressed 16-bit RGB TIFF (alpha dropped).
 * @param {Uint16Array} rgba width*height*4 samples, sRGB-encoded
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array<ArrayBuffer>} complete TIFF file bytes
 */
export function encodeTiff16(rgba, width, height) {
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  // Tags, ascending by id (required by the spec). RATIONAL and the
  // 3-element BitsPerSample don't fit in an entry's 4 value bytes, so they
  // point into an extra-values block between the IFD and the strip.
  /** @type {[number, number, number, number][]} */
  const entries = [
    [256, LONG, 1, width], // ImageWidth
    [257, LONG, 1, height], // ImageLength
    [258, SHORT, 3, 0], // BitsPerSample → extra
    [259, SHORT, 1, 1], // Compression: none
    [262, SHORT, 1, 2], // PhotometricInterpretation: RGB
    [273, LONG, 1, 0], // StripOffsets → strip
    [277, SHORT, 1, 3], // SamplesPerPixel
    [278, LONG, 1, height], // RowsPerStrip: single strip
    [279, LONG, 1, width * height * 6], // StripByteCounts
    [282, RATIONAL, 1, 0], // XResolution → extra
    [283, RATIONAL, 1, 0], // YResolution → extra
    [284, SHORT, 1, 1], // PlanarConfiguration: chunky
    [296, SHORT, 1, 2], // ResolutionUnit: inch
  ];
  const ifdBytes = 2 + entries.length * ENTRY_BYTES + 4;
  const bitsOffset = HEADER_BYTES + ifdBytes;
  const xResOffset = bitsOffset + 8; // 6 bytes of SHORTs, padded to even 8
  const yResOffset = xResOffset + 8;
  const stripOffset = yResOffset + 8;
  entries[2][3] = bitsOffset;
  entries[5][3] = stripOffset;
  entries[9][3] = xResOffset;
  entries[10][3] = yResOffset;

  const file = new Uint8Array(stripOffset + width * height * 6);
  const view = new DataView(file.buffer);

  view.setUint8(0, littleEndian ? 0x49 : 0x4d); // "II" / "MM"
  view.setUint8(1, littleEndian ? 0x49 : 0x4d);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, HEADER_BYTES, littleEndian); // first (only) IFD

  view.setUint16(HEADER_BYTES, entries.length, littleEndian);
  let at = HEADER_BYTES + 2;
  for (const [tag, type, count, value] of entries) {
    view.setUint16(at, tag, littleEndian);
    view.setUint16(at + 2, type, littleEndian);
    view.setUint32(at + 4, count, littleEndian);
    // Inline SHORT values sit in the upper-left of the 4 value bytes.
    if (type === SHORT && count === 1) {
      view.setUint16(at + 8, value, littleEndian);
    } else {
      view.setUint32(at + 8, value, littleEndian);
    }
    at += ENTRY_BYTES;
  }
  view.setUint32(at, 0, littleEndian); // no next IFD

  for (let i = 0; i < 3; i++) {
    view.setUint16(bitsOffset + i * 2, 16, littleEndian);
  }
  for (const off of [xResOffset, yResOffset]) {
    view.setUint32(off, 72, littleEndian); // 72/1 dpi
    view.setUint32(off + 4, 1, littleEndian);
  }

  const strip = new Uint16Array(file.buffer, stripOffset, width * height * 3);
  for (let src = 0, dst = 0; dst < strip.length; src += 4, dst += 3) {
    strip[dst] = rgba[src];
    strip[dst + 1] = rgba[src + 1];
    strip[dst + 2] = rgba[src + 2];
  }
  return file;
}
