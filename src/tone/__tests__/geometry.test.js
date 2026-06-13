import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orientedDims,
  coverScale,
  frameToSource,
  rotateRectCW,
  rotateRectCCW,
  frameRectToSource,
  isIdentityGeometry,
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

/** @param {[number, number]} a @param {[number, number]} b */
function assertPtClose(a, b) {
  assert.ok(
    Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9,
    `(${a[0]}, ${a[1]}) != (${b[0]}, ${b[1]})`,
  );
}

test("isIdentityGeometry: only the all-default geometry is identity", () => {
  assert.ok(
    isIdentityGeometry({ orient: 0, angle: 0, flipH: false, flipV: false }),
  );
  assert.ok(
    !isIdentityGeometry({ orient: 0, angle: 0, flipH: true, flipV: false }),
  );
  assert.ok(
    !isIdentityGeometry({ orient: 0, angle: 0, flipH: false, flipV: true }),
  );
  assert.ok(
    !isIdentityGeometry({ orient: 1, angle: 0, flipH: false, flipV: false }),
  );
  assert.ok(
    !isIdentityGeometry({ orient: 0, angle: 5, flipH: false, flipV: false }),
  );
});

test("frameToSource: flipH mirrors frame x, flipV mirrors frame y", () => {
  const W = 100;
  const H = 80;
  // flipH: frame (fx, fy) samples source (W - fx, fy) at orient 0
  assertPtClose(
    frameToSource(
      { orient: 0, angle: 0, flipH: true, flipV: false },
      0,
      0,
      W,
      H,
    ),
    [W, 0],
  );
  assertPtClose(
    frameToSource(
      { orient: 0, angle: 0, flipH: true, flipV: false },
      30,
      20,
      W,
      H,
    ),
    [W - 30, 20],
  );
  // flipV: frame (fx, fy) samples source (fx, H - fy)
  assertPtClose(
    frameToSource(
      { orient: 0, angle: 0, flipH: false, flipV: true },
      0,
      0,
      W,
      H,
    ),
    [0, H],
  );
  assertPtClose(
    frameToSource(
      { orient: 0, angle: 0, flipH: false, flipV: true },
      30,
      20,
      W,
      H,
    ),
    [30, H - 20],
  );
});

test("frameToSource: double flip is the identity", () => {
  const g0 = { orient: 0, angle: 0, flipH: false, flipV: false };
  const W = 100;
  const H = 80;
  for (const [fx, fy] of [
    [12.5, 7.25],
    [0, 0],
    [100, 80],
    [73, 11],
  ]) {
    // a flip then the same flip returns each pixel to where it started:
    // mapping through flipH=true equals mapping the *mirrored* frame point
    // through identity, so flipping the input twice is a no-op
    const fh = { ...g0, flipH: true };
    const fv = { ...g0, flipV: true };
    assertPtClose(
      frameToSource(fh, W - fx, fy, W, H),
      frameToSource(g0, fx, fy, W, H),
    );
    assertPtClose(
      frameToSource(fv, fx, H - fy, W, H),
      frameToSource(g0, fx, fy, W, H),
    );
  }
});

test("frameToSource: flipH+flipV samples the same source as a 180° turn", () => {
  const W = 100;
  const H = 80;
  for (const [fx, fy] of [
    [0, 0],
    [30, 20],
    [100, 80],
  ]) {
    // orient 2 (rotate 180): [W - fx, H - fy]; flipH+flipV at orient 0
    // reflects to the same source pixel
    assertPtClose(
      frameToSource(
        { orient: 0, angle: 0, flipH: true, flipV: true },
        fx,
        fy,
        W,
        H,
      ),
      frameToSource(
        { orient: 2, angle: 0, flipH: false, flipV: false },
        fx,
        fy,
        W,
        H,
      ),
    );
  }
});

test("frameToSource: flip composes correctly with each orient", () => {
  const W = 100;
  const H = 80;
  for (const orient of [0, 1, 2, 3]) {
    const { width: fw, height: fh } = orientedDims(orient, W, H);
    // flipH at orient o maps frame (fx, fy) to whatever the unflipped
    // mapping gives for the horizontally-mirrored frame point (fw - fx, fy)
    const sx = 0.37 * fw;
    const sy = 0.62 * fh;
    assertPtClose(
      frameToSource(
        { orient, angle: 0, flipH: true, flipV: false },
        sx,
        sy,
        W,
        H,
      ),
      frameToSource(
        { orient, angle: 0, flipH: false, flipV: false },
        fw - sx,
        sy,
        W,
        H,
      ),
    );
    assertPtClose(
      frameToSource(
        { orient, angle: 0, flipH: false, flipV: true },
        sx,
        sy,
        W,
        H,
      ),
      frameToSource(
        { orient, angle: 0, flipH: false, flipV: false },
        sx,
        fh - sy,
        W,
        H,
      ),
    );
  }
});

test("frameToSource: flipped corners land on the mirrored source corners", () => {
  const W = 100;
  const H = 80;
  // orient 1 (frame 80×100) with flipH. Without flip, frame top-left (0,0)
  // → source (0, H); the flip mirrors frame x first, so (0,0) maps as the
  // unflipped (fw, 0) = (80, 0) point would → source (0, 0).
  const flipped = { orient: 1, angle: 0, flipH: true, flipV: false };
  assertPtClose(frameToSource(flipped, 0, 0, W, H), [0, 0]);
  assertPtClose(frameToSource(flipped, 80, 100, W, H), [W, H]);
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
