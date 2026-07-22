import assert from "node:assert/strict";
import test from "node:test";

import {
  camToSrgbMatrix,
  developLinearRgb,
  invert3x3,
  orientIndex,
  orientedSize,
  pickColorMatrix,
} from "../dng-color.js";

/** @returns {import("../dng.js").JxlDng} */
function baseDng(overrides = {}) {
  return {
    width: 2,
    height: 2,
    bitsPerSample: 16,
    samplesPerPixel: 3,
    orientation: 1,
    make: "t",
    model: "t",
    blackLevel: [0],
    whiteLevel: [65535],
    asShotNeutral: null,
    colorMatrix1: null,
    colorMatrix2: null,
    calibrationIlluminant1: 0,
    calibrationIlluminant2: 0,
    exif: { iso: 0, shutter: 0, aperture: 0, focalLen: 0 },
    tiles: [],
    tileWidth: 2,
    tileHeight: 2,
    ...overrides,
  };
}

test("invert3x3 inverts and rejects singular matrices", () => {
  const m = [2, 0, 0, 0, 4, 0, 0, 0, 8];
  assert.deepEqual(invert3x3(m), [0.5, 0, 0, 0, 0.25, 0, 0, 0, 0.125]);
  assert.throws(() => invert3x3([1, 2, 3, 2, 4, 6, 0, 0, 1]));
});

test("camToSrgbMatrix of an identity-camera is identity-ish", () => {
  // A camera whose response IS sRGB: xyzToCam = inverse(XYZ_FROM_SRGB),
  // so cam←sRGB is identity, rows already sum to 1, and the result is I.
  const srgbToXyz = [
    0.412453, 0.35758, 0.180423, 0.212671, 0.71516, 0.072169, 0.019334,
    0.119193, 0.950227,
  ];
  const m = camToSrgbMatrix(invert3x3(srgbToXyz));
  const expected = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  m.forEach((v, i) =>
    assert.ok(Math.abs(v - expected[i]) < 1e-6, `${i}: ${v}`),
  );
});

test("pickColorMatrix prefers the D65-calibrated matrix", () => {
  const cm1 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const cm2 = [2, 0, 0, 0, 2, 0, 0, 0, 2];
  // Samsung order: illuminant1 = D65(21), illuminant2 = StdA(17).
  assert.equal(
    pickColorMatrix(
      baseDng({
        colorMatrix1: cm1,
        colorMatrix2: cm2,
        calibrationIlluminant1: 21,
        calibrationIlluminant2: 17,
      }),
    ),
    cm1,
  );
  // Adobe order: illuminant1 = StdA(17), illuminant2 = D65(21).
  assert.equal(
    pickColorMatrix(
      baseDng({
        colorMatrix1: cm1,
        colorMatrix2: cm2,
        calibrationIlluminant1: 17,
        calibrationIlluminant2: 21,
      }),
    ),
    cm2,
  );
  // Untagged: DNG convention puts daylight second.
  assert.equal(
    pickColorMatrix(baseDng({ colorMatrix1: cm1, colorMatrix2: cm2 })),
    cm2,
  );
  assert.equal(pickColorMatrix(baseDng({ colorMatrix1: cm1 })), cm1);
  assert.equal(pickColorMatrix(baseDng()), null);
});

test("orientation helpers cover the transposing cases", () => {
  assert.deepEqual(orientedSize(1, 4, 3), { width: 4, height: 3 });
  assert.deepEqual(orientedSize(6, 4, 3), { width: 3, height: 4 });
  assert.deepEqual(orientedSize(8, 4, 3), { width: 3, height: 4 });
  // Rotate 90 CW (6): source top-right (1,0) of a 2×2 → dest (1,1)... walk
  // all four pixels of a 2×2 and assert the mapping is a permutation.
  const seen = new Set();
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) seen.add(orientIndex(6, x, y, 2, 2));
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
  // Identity leaves indexes alone.
  assert.equal(orientIndex(1, 1, 1, 2, 2), 3);
  // Rotate 90 CW puts the top-left source pixel at the top-right.
  assert.equal(orientIndex(6, 0, 0, 2, 2), 1);
});

test("developLinearRgb applies white balance and clips", () => {
  // 2×2 gray ramp; neutral of [0.5, 1, 0.5] doubles R and B.
  const dng = baseDng({ asShotNeutral: [0.5, 1, 0.5] });
  const q = 65535 / 4;
  const data = new Uint16Array(
    [
      q,
      q,
      q,
      /**/ 2 * q,
      2 * q,
      2 * q,
      3 * q,
      3 * q,
      3 * q,
      /**/ 65535,
      65535,
      65535,
    ].map(Math.round),
  );
  const out = developLinearRgb(data, dng);
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.equal(out.colors, 3);
  // First pixel: R doubled, G kept, B doubled.
  assert.ok(Math.abs(out.data[0] - 2 * q) <= 2);
  assert.ok(Math.abs(out.data[1] - q) <= 2);
  assert.ok(Math.abs(out.data[2] - 2 * q) <= 2);
  // Fourth pixel: everything clips to full scale, staying neutral.
  assert.deepEqual([...out.data.slice(9)], [65535, 65535, 65535]);
});

test("developLinearRgb honors black/white levels", () => {
  const dng = baseDng({ blackLevel: [4096], whiteLevel: [61440] });
  const data = new Uint16Array([
    4096, 4096, 4096, /**/ 61440, 61440, 61440, 2000, 2000, 2000, /**/ 32768,
    32768, 32768,
  ]);
  const out = developLinearRgb(data, dng);
  assert.deepEqual([...out.data.slice(0, 3)], [0, 0, 0]); // at black
  assert.deepEqual([...out.data.slice(3, 6)], [65535, 65535, 65535]); // at white
  assert.deepEqual([...out.data.slice(6, 9)], [0, 0, 0]); // below black clamps
  const mid = (32768 - 4096) / (61440 - 4096);
  assert.ok(Math.abs(out.data[9] / 65535 - mid) < 1e-3);
});

test("developLinearRgb orients the output", () => {
  // 2×1 image rotated 90 CW (orientation 6) becomes 1×2 with the left
  // pixel on top.
  const dng = baseDng({ width: 2, height: 1, orientation: 6 });
  const data = new Uint16Array([65535, 0, 0, /**/ 0, 65535, 0]);
  const out = developLinearRgb(data, dng);
  assert.equal(out.width, 1);
  assert.equal(out.height, 2);
  assert.deepEqual([...out.data.slice(0, 3)], [65535, 0, 0]);
  assert.deepEqual([...out.data.slice(3, 6)], [0, 65535, 0]);
});
