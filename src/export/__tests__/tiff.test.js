import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeTiff16 } from "../tiff.js";

/** Parse the single IFD of a TIFF buffer into tag → {type, count, value}. */
function parseTiff(/** @type {Uint8Array} */ file) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const order = String.fromCharCode(file[0], file[1]);
  assert.ok(order === "II" || order === "MM", `byte order ${order}`);
  const le = order === "II";
  assert.equal(view.getUint16(2, le), 42);
  const ifd = view.getUint32(4, le);
  const count = view.getUint16(ifd, le);
  /** @type {Map<number, { type: number, count: number, value: number }>} */
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    const type = view.getUint16(at + 2, le);
    const n = view.getUint32(at + 4, le);
    const value =
      type === 3 && n === 1
        ? view.getUint16(at + 8, le)
        : view.getUint32(at + 8, le);
    tags.set(view.getUint16(at, le), { type, count: n, value });
  }
  assert.equal(view.getUint32(ifd + 2 + count * 12, le), 0, "next IFD");
  return { view, le, tags };
}

test("encodeTiff16 produces a well-formed 16-bit RGB TIFF", () => {
  const width = 3;
  const height = 2;
  const rgba = new Uint16Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = p * 10000;
    rgba[p * 4 + 1] = 65535 - p * 10000;
    rgba[p * 4 + 2] = p * 137;
    rgba[p * 4 + 3] = 65535; // alpha, must be dropped
  }
  const file = encodeTiff16(rgba, width, height);
  const { view, le, tags } = parseTiff(file);

  assert.equal(tags.get(256)?.value, width);
  assert.equal(tags.get(257)?.value, height);
  assert.equal(tags.get(259)?.value, 1); // uncompressed
  assert.equal(tags.get(262)?.value, 2); // RGB
  assert.equal(tags.get(277)?.value, 3); // samples per pixel
  assert.equal(tags.get(278)?.value, height); // single strip
  assert.equal(tags.get(284)?.value, 1); // chunky

  const bits = tags.get(258);
  assert.ok(bits);
  assert.equal(bits.count, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(view.getUint16(bits.value + i * 2, le), 16);
  }

  const stripOffset = tags.get(273)?.value;
  const stripBytes = tags.get(279)?.value;
  assert.ok(stripOffset !== undefined && stripBytes !== undefined);
  assert.equal(stripBytes, width * height * 6);
  assert.equal(stripOffset % 2, 0, "strip starts on a word boundary");
  assert.equal(file.length, stripOffset + stripBytes);

  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) {
      assert.equal(
        view.getUint16(stripOffset + (p * 3 + c) * 2, le),
        rgba[p * 4 + c],
        `pixel ${p} channel ${c}`,
      );
    }
  }
});

test("encodeTiff16 IFD tags are sorted ascending", () => {
  const file = encodeTiff16(new Uint16Array(4), 1, 1);
  const { view, le } = parseTiff(file);
  const ifd = view.getUint32(4, le);
  const count = view.getUint16(ifd, le);
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const tag = view.getUint16(ifd + 2 + i * 12, le);
    assert.ok(tag > prev, `tag ${tag} after ${prev}`);
    prev = tag;
  }
});
