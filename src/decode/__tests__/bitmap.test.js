import assert from "node:assert/strict";
import test from "node:test";

import {
  isJpeg,
  isHeic,
  isBitmapImage,
  linearizeRgba8,
  P3_TO_SRGB,
} from "../bitmap.js";

/** @param {(number | string)[]} parts */
function bytes(...parts) {
  /** @type {number[]} */
  const out = [];
  for (const p of parts) {
    if (typeof p === "string") {
      for (const c of p) out.push(c.charCodeAt(0));
    } else {
      out.push(p);
    }
  }
  return new Uint8Array(out);
}

/** A minimal ftyp header: size, "ftyp", major brand, minor, compatible. */
function ftyp(major = "heic", compatible = ["mif1"]) {
  const size = 16 + compatible.length * 4;
  return bytes(
    (size >> 24) & 0xff,
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
    "ftyp",
    major,
    0,
    0,
    0,
    0,
    ...compatible,
  );
}

test("isJpeg detects the SOI/marker magic", () => {
  assert.equal(isJpeg(bytes(0xff, 0xd8, 0xff, 0xe0)), true);
  assert.equal(isJpeg(bytes(0xff, 0xd8)), false); // too short
  assert.equal(isJpeg(bytes(0x49, 0x49, 0x2a, 0x00)), false); // TIFF
});

test("isHeic accepts HEVC still brands, major or compatible", () => {
  assert.equal(isHeic(ftyp("heic", [])), true);
  assert.equal(isHeic(ftyp("heix", [])), true);
  assert.equal(isHeic(ftyp("isom", ["dumb", "heic"])), true);
});

test("isHeic rejects AVIF and non-ISOBMFF data", () => {
  assert.equal(isHeic(ftyp("avif", ["avif"])), false);
  assert.equal(isHeic(bytes(0xff, 0xd8, 0xff, 0xe0)), false);
  assert.equal(isHeic(new Uint8Array(8)), false);
});

test("isBitmapImage covers both families", () => {
  assert.equal(isBitmapImage(bytes(0xff, 0xd8, 0xff, 0xe0)), true);
  assert.equal(isBitmapImage(ftyp()), true);
  assert.equal(isBitmapImage(bytes(0x49, 0x49, 0x2a, 0x00)), false);
});

/** The sRGB EOTF, for computing expected values independently. */
/** @param {number} u8 */
function srgbToLinear(u8) {
  const c = u8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

test("linearizeRgba8 applies the sRGB EOTF into 16-bit", () => {
  const rgba = {
    data: new Uint8ClampedArray([0, 128, 255, 255, 10, 200, 64, 255]),
    width: 2,
    height: 1,
  };
  const out = linearizeRgba8(rgba);
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.equal(out.colors, 3);
  assert.equal(out.bits, 16);
  assert.equal(out.data.length, 6);
  const expected = [0, 128, 255, 10, 200, 64].map((v) =>
    Math.round(srgbToLinear(v) * 65535),
  );
  assert.deepEqual(Array.from(out.data), expected);
});

test("linearizeRgba8 with the identity matrix matches the LUT path", () => {
  const rgba = {
    data: new Uint8ClampedArray([0, 128, 255, 255]),
    width: 1,
    height: 1,
  };
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  assert.deepEqual(
    Array.from(linearizeRgba8(rgba, identity).data),
    Array.from(linearizeRgba8(rgba).data),
  );
});

test("linearizeRgba8 P3 conversion keeps white and clips pure red", () => {
  const rgba = {
    data: new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255]),
    width: 2,
    height: 1,
  };
  const out = linearizeRgba8(rgba, P3_TO_SRGB);
  // The matrix rows sum to 1, so white is preserved.
  assert.deepEqual(Array.from(out.data.subarray(0, 3)), [65535, 65535, 65535]);
  // P3 pure red lies outside sRGB: red clips to full, green floors at 0.
  assert.equal(out.data[3], 65535);
  assert.equal(out.data[4], 0);
});
