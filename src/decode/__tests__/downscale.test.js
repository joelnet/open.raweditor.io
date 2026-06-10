import { test } from "node:test";
import assert from "node:assert/strict";
import { boxDownscaleToRgba16 } from "../downscale.js";

test("4x4 RGB u16 → 2x2 box averages", () => {
  // Each 2x2 block has a known average; channel values distinct.
  const width = 4;
  const height = 4;
  const data = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = y * width + x; // r: 0..15
      data[i + 1] = 100; // g: constant
      data[i + 2] = x; // b: column index
    }
  }
  const out = boxDownscaleToRgba16(
    { data, width, height, colors: 3, bits: 16 },
    2,
  );
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  // top-left block r values: 0,1,4,5 → avg 2.5 → truncated to 2
  assert.equal(out.pixels[0], 2);
  assert.equal(out.pixels[1], 100);
  assert.equal(out.pixels[2], 0); // b: cols 0,1 → 0.5 → 0
  assert.equal(out.pixels[3], 65535);
  // bottom-right block r: 10,11,14,15 → 12.5 → 12
  const o = (1 * 2 + 1) * 4;
  assert.equal(out.pixels[o], 12);
  assert.equal(out.pixels[o + 2], 2); // b: cols 2,3 → 2.5 → 2
});

test("factor 1 repacks RGB to RGBA without resampling", () => {
  const data = new Uint16Array([1, 2, 3, 4, 5, 6]);
  const out = boxDownscaleToRgba16(
    { data, width: 2, height: 1, colors: 3, bits: 16 },
    2560,
  );
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.deepEqual([...out.pixels], [1, 2, 3, 65535, 4, 5, 6, 65535]);
});

test("odd dimensions: partial edge boxes average actual samples", () => {
  // 3x3 image, maxEdge 2 → factor 2 → 2x2 output with partial boxes
  const width = 3;
  const height = 3;
  const data = new Uint16Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data[i * 3] = 10; // r constant
  const out = boxDownscaleToRgba16(
    { data, width, height, colors: 3, bits: 16 },
    2,
  );
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  for (let p = 0; p < 4; p++) {
    assert.equal(out.pixels[p * 4], 10, `pixel ${p} r`);
    assert.equal(out.pixels[p * 4 + 3], 65535, `pixel ${p} a`);
  }
});

test("8-bit input is scaled to 16-bit range", () => {
  const data = new Uint8Array([255, 128, 0]);
  const out = boxDownscaleToRgba16(
    { data, width: 1, height: 1, colors: 3, bits: 8 },
    2560,
  );
  assert.equal(out.pixels[0], 65535);
  assert.equal(out.pixels[1], 128 * 257);
  assert.equal(out.pixels[2], 0);
});

test("4-channel input ignores source alpha, emits opaque", () => {
  const data = new Uint16Array([7, 8, 9, 1234]);
  const out = boxDownscaleToRgba16(
    { data, width: 1, height: 1, colors: 4, bits: 16 },
    2560,
  );
  assert.deepEqual([...out.pixels], [7, 8, 9, 65535]);
});

test("rejects unsupported channel counts", () => {
  assert.throws(() =>
    boxDownscaleToRgba16(
      { data: new Uint16Array(4), width: 2, height: 2, colors: 1, bits: 16 },
      2,
    ),
  );
});
