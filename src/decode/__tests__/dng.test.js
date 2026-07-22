import assert from "node:assert/strict";
import test from "node:test";

import { COMPRESSION_JXL, isJxlDng, parseJxlDng } from "../dng.js";

// --- tiny TIFF writer -------------------------------------------------------

/**
 * @typedef {{ tag: number, type: number, values: number[] | string }} Tag
 */

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };

/**
 * Assemble a little-endian TIFF from IFDs of simple tags. Rationals are
 * given as [num, den] pairs flattened into the values array.
 * @param {Tag[][]} ifds top-level IFD chain; SubIFDs are spliced by the
 *   caller via placeholder offsets patched below (tag 330 values are
 *   IFD indexes into `ifds` and get rewritten to real offsets).
 */
function buildTiff(ifds) {
  // Layout: header, then each IFD followed by its own heap.
  /** @type {{ bytes: Uint8Array, offset: number }[]} */
  const built = [];
  let cursor = 8;
  const offsets = [];
  for (const tags of ifds) {
    const { size } = layoutIfd(tags);
    offsets.push(cursor);
    built.push({ bytes: new Uint8Array(size), offset: cursor });
    cursor += size;
  }
  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, offsets[0], true);
  ifds.forEach((tags, i) => {
    writeIfd(out, view, offsets[i], tags, offsets);
  });
  return out;
}

/** @param {Tag[]} tags */
function layoutIfd(tags) {
  let heap = 0;
  for (const t of tags) {
    const count =
      typeof t.values === "string"
        ? t.values.length + 1
        : t.type === 5 || t.type === 10
          ? t.values.length / 2
          : t.values.length;
    const size = (TYPE_SIZES[t.type] ?? 1) * count;
    if (size > 4) heap += size + (size % 2);
  }
  return { size: 2 + tags.length * 12 + 4 + heap };
}

/**
 * @param {Uint8Array} out
 * @param {DataView} view
 * @param {number} offset
 * @param {Tag[]} tags
 * @param {number[]} ifdOffsets real file offsets of each IFD
 */
function writeIfd(out, view, offset, tags, ifdOffsets) {
  const sorted = [...tags].sort((a, b) => a.tag - b.tag);
  view.setUint16(offset, sorted.length, true);
  let heap = offset + 2 + sorted.length * 12 + 4;
  sorted.forEach((t, i) => {
    const e = offset + 2 + i * 12;
    const isStr = typeof t.values === "string";
    const rat = t.type === 5 || t.type === 10;
    const vals = isStr
      ? [...t.values].map((c) => c.charCodeAt(0)).concat(0)
      : t.tag === 330
        ? t.values.map((idx) => ifdOffsets[idx])
        : t.values;
    const count = rat ? vals.length / 2 : vals.length;
    view.setUint16(e, t.tag, true);
    view.setUint16(e + 2, t.type, true);
    view.setUint32(e + 4, count, true);
    const size = (TYPE_SIZES[t.type] ?? 1) * count;
    const base = size <= 4 ? e + 8 : heap;
    if (size > 4) {
      view.setUint32(e + 8, heap, true);
      heap += size + (size % 2);
    }
    vals.forEach((v, j) => {
      if (t.type === 1 || t.type === 2) out[base + j] = v;
      else if (t.type === 3) view.setUint16(base + j * 2, v, true);
      else if (t.type === 4) view.setUint32(base + j * 4, v, true);
      else if (t.type === 5) view.setUint32(base + j * 4, v, true);
      else if (t.type === 10) view.setInt32(base + j * 4, v, true);
    });
  });
  view.setUint32(offset + 2 + sorted.length * 12, 0, true);
}

/** A Samsung-shaped JXL DNG: raw in IFD0, one strip, preview in a SubIFD. */
function samsungLikeDng({ compression = COMPRESSION_JXL } = {}) {
  return buildTiff([
    [
      { tag: 254, type: 4, values: [0] },
      { tag: 256, type: 4, values: [4000] },
      { tag: 257, type: 4, values: [3000] },
      { tag: 258, type: 3, values: [16, 16, 16] },
      { tag: 259, type: 3, values: [compression] },
      { tag: 262, type: 3, values: [34892] },
      { tag: 271, type: 2, values: "samsung" },
      { tag: 272, type: 2, values: "SM-S901E" },
      { tag: 273, type: 4, values: [2_060_289] },
      { tag: 274, type: 3, values: [6] },
      { tag: 277, type: 3, values: [3] },
      { tag: 278, type: 4, values: [3000] },
      { tag: 279, type: 4, values: [40_910_499] },
      { tag: 330, type: 4, values: [1] }, // SubIFD → ifds[1]
      { tag: 50714, type: 3, values: [0] },
      { tag: 50717, type: 4, values: [65535] },
      {
        tag: 50721,
        type: 10,
        values: [
          799, 1024, -223, 1024, -116, 1024, -548, 1024, 1436, 1024, 100, 1024,
          -153, 1024, 320, 1024, 470, 1024,
        ],
      },
      { tag: 50728, type: 5, values: [183, 512, 1, 1, 403, 512] },
      { tag: 50778, type: 3, values: [21] },
    ],
    [
      // Preview SubIFD — must not be mistaken for the raw image.
      { tag: 254, type: 4, values: [1] },
      { tag: 256, type: 4, values: [4000] },
      { tag: 257, type: 4, values: [3000] },
      { tag: 259, type: 3, values: [7] },
      { tag: 273, type: 4, values: [2208] },
      { tag: 279, type: 4, values: [2_058_081] },
    ],
  ]);
}

// --- tests ------------------------------------------------------------------

test("parses a Samsung-shaped JXL DNG", () => {
  const dng = parseJxlDng(samsungLikeDng());
  assert.ok(dng);
  assert.equal(dng.width, 4000);
  assert.equal(dng.height, 3000);
  assert.equal(dng.samplesPerPixel, 3);
  assert.equal(dng.bitsPerSample, 16);
  assert.equal(dng.orientation, 6);
  assert.equal(dng.make, "samsung");
  assert.equal(dng.model, "SM-S901E");
  assert.deepEqual(dng.tiles, [
    { offset: 2_060_289, byteCount: 40_910_499, x: 0, y: 0 },
  ]);
  assert.equal(dng.calibrationIlluminant1, 21);
  assert.ok(dng.colorMatrix1);
  assert.ok(Math.abs(dng.colorMatrix1[0] - 799 / 1024) < 1e-9);
  assert.ok(dng.asShotNeutral);
  assert.ok(Math.abs(dng.asShotNeutral[0] - 183 / 512) < 1e-9);
});

test("ignores non-JXL DNGs and non-TIFF files", () => {
  assert.equal(parseJxlDng(samsungLikeDng({ compression: 7 })), null);
  assert.equal(isJxlDng(samsungLikeDng({ compression: 7 })), false);
  assert.equal(
    isJxlDng(
      new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]),
    ),
    false,
  );
  assert.equal(isJxlDng(new Uint8Array(4)), false);
});

test("finds the raw image in a SubIFD (Apple-style layout)", () => {
  const bytes = buildTiff([
    [
      // IFD0 is a thumbnail; raw lives in the SubIFD.
      { tag: 254, type: 4, values: [1] },
      { tag: 256, type: 4, values: [640] },
      { tag: 257, type: 4, values: [480] },
      { tag: 259, type: 3, values: [1] },
      { tag: 274, type: 3, values: [1] },
      { tag: 330, type: 4, values: [1] },
      { tag: 50728, type: 5, values: [1, 2, 1, 1, 1, 2] },
    ],
    [
      { tag: 254, type: 4, values: [0] },
      { tag: 256, type: 4, values: [4032] },
      { tag: 257, type: 4, values: [3024] },
      { tag: 258, type: 3, values: [16, 16, 16] },
      { tag: 259, type: 3, values: [COMPRESSION_JXL] },
      { tag: 277, type: 3, values: [3] },
      { tag: 322, type: 4, values: [1024] },
      { tag: 323, type: 4, values: [1024] },
      {
        tag: 324,
        type: 4,
        values: [
          1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000,
          12000,
        ],
      },
      {
        tag: 325,
        type: 4,
        values: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
      },
    ],
  ]);
  const dng = parseJxlDng(bytes);
  assert.ok(dng);
  assert.equal(dng.width, 4032);
  assert.equal(dng.height, 3024);
  assert.equal(dng.tileWidth, 1024);
  assert.equal(dng.tileHeight, 1024);
  assert.equal(dng.tiles.length, 12);
  // 4032 / 1024 → 4 tiles across; the 5th tile starts row two.
  assert.deepEqual(dng.tiles[4], {
    offset: 5000,
    byteCount: 10,
    x: 0,
    y: 1024,
  });
  // AsShotNeutral comes from IFD0 even when the raw is in a SubIFD.
  assert.ok(dng.asShotNeutral);
  assert.equal(dng.asShotNeutral[0], 0.5);
});
