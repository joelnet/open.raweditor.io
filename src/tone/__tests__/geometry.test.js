import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orientedDims,
  coverScale,
  frameToSource,
  rotateRectCW,
  rotateRectCCW,
  frameRectToSource,
} from "../geometry.js";
import { toneMapRows, ZERO_SETTINGS } from "../tone-math.js";

/** @param {Record<string, number>} a @param {Record<string, number>} b */
function assertRectClose(a, b) {
  for (const k of ["x", "y", "w", "h"]) {
    assert.ok(Math.abs(a[k] - b[k]) < 1e-12, `${k}: ${a[k]} != ${b[k]}`);
  }
}

test("orientedDims swaps on odd quarter-turns", () => {
  assert.deepEqual(orientedDims(0, 40, 30), { width: 40, height: 30 });
  assert.deepEqual(orientedDims(1, 40, 30), { width: 30, height: 40 });
  assert.deepEqual(orientedDims(2, 40, 30), { width: 40, height: 30 });
  assert.deepEqual(orientedDims(3, 40, 30), { width: 30, height: 40 });
});

test("coverScale is 1 at level and symmetric in sign", () => {
  assert.equal(coverScale(0, 100, 80), 1);
  assert.equal(coverScale(10, 100, 80), coverScale(-10, 100, 80));
  // square at 45°: needs √2
  assert.ok(Math.abs(coverScale(45, 50, 50) - Math.SQRT2) < 1e-12);
  // 3:2 at 45°: cos + sin·(3/2)
  const expected = Math.SQRT1_2 + Math.SQRT1_2 * 1.5;
  assert.ok(Math.abs(coverScale(45, 300, 200) - expected) < 1e-12);
});

test("frameToSource: identity geometry is a no-op", () => {
  assert.deepEqual(
    frameToSource({ orient: 0, angle: 0 }, 12.5, 7.25, 100, 80),
    [12.5, 7.25],
  );
});

test("frameToSource: pure quarter-turns map corners correctly", () => {
  const W = 100;
  const H = 80;
  // one CW turn: frame is 80×100; source bottom-left lands at frame top-left
  assert.deepEqual(frameToSource({ orient: 1, angle: 0 }, 0, 0, W, H), [0, H]);
  assert.deepEqual(frameToSource({ orient: 1, angle: 0 }, H, W, W, H), [W, 0]);
  // two turns: opposite corner
  assert.deepEqual(frameToSource({ orient: 2, angle: 0 }, 0, 0, W, H), [W, H]);
  // CCW turn: source top-right lands at frame top-left
  assert.deepEqual(frameToSource({ orient: 3, angle: 0 }, 0, 0, W, H), [W, 0]);
});

test("frameToSource: straighten keeps the center fixed", () => {
  for (const orient of [0, 1, 2, 3]) {
    const { width: fw, height: fh } = orientedDims(orient, 100, 80);
    const [sx, sy] = frameToSource(
      { orient, angle: 17 },
      fw / 2,
      fh / 2,
      100,
      80,
    );
    assert.ok(Math.abs(sx - 50) < 1e-9 && Math.abs(sy - 40) < 1e-9);
  }
});

test("frameToSource: cover scale keeps frame corners inside the source", () => {
  for (const angle of [-45, -10, 5, 30, 45]) {
    for (const [fx, fy] of [
      [0, 0],
      [100, 0],
      [0, 80],
      [100, 80],
    ]) {
      const [sx, sy] = frameToSource({ orient: 0, angle }, fx, fy, 100, 80);
      assert.ok(sx > -1e-9 && sx < 100 + 1e-9, `sx ${sx} at ${angle}°`);
      assert.ok(sy > -1e-9 && sy < 80 + 1e-9, `sy ${sy} at ${angle}°`);
    }
  }
});

test("rotateRectCW / rotateRectCCW are inverses and follow content", () => {
  const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  assertRectClose(rotateRectCW(r), { x: 0.4, y: 0.1, w: 0.4, h: 0.3 });
  assertRectClose(rotateRectCCW(rotateRectCW(r)), r);
  assertRectClose(rotateRectCW(rotateRectCCW(r)), r);
  const full = { x: 0, y: 0, w: 1, h: 1 };
  assertRectClose(rotateRectCW(full), full);
});

test("frameRectToSource undoes the rect rotation", () => {
  const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  assertRectClose(frameRectToSource(0, r), r);
  assertRectClose(frameRectToSource(1, rotateRectCW(r)), r);
  assertRectClose(frameRectToSource(3, rotateRectCCW(r)), r);
  assertRectClose(frameRectToSource(2, rotateRectCW(rotateRectCW(r))), r);
});

test("toneMapRows rotates pixels with the frame", () => {
  // 2×1 source: white then black
  const image = {
    data: new Uint16Array([65535, 65535, 65535, 0, 0, 0]),
    width: 2,
    height: 1,
    colors: 3,
    bits: 16,
  };
  const out = new Uint8ClampedArray(1 * 2 * 4);
  toneMapRows(
    { ...image, data: image.data.slice() },
    ZERO_SETTINGS,
    out,
    0,
    2,
    undefined,
    { orient: 1, angle: 0 },
  );
  // one CW turn: the left (white) pixel becomes the top one
  assert.deepEqual([out[0], out[4]], [255, 0]);

  const ccw = new Uint8ClampedArray(1 * 2 * 4);
  toneMapRows(
    { ...image, data: image.data.slice() },
    ZERO_SETTINGS,
    ccw,
    0,
    2,
    undefined,
    { orient: 3, angle: 0 },
  );
  // one CCW turn: the right (black) pixel becomes the top one
  assert.deepEqual([ccw[0], ccw[4]], [0, 255]);
});
