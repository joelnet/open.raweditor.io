import test from "node:test";
import assert from "node:assert/strict";
import { moveRect, resizeRect, fitAspect } from "../crop-math.js";

const BW = 800;
const BH = 600;

test("moveRect translates and clamps to the bounds", () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(moveRect(start, 50, -20, BW, BH), {
    x: 150,
    y: 80,
    w: 200,
    h: 100,
  });
  assert.deepEqual(moveRect(start, -500, 0, BW, BH).x, 0);
  assert.deepEqual(moveRect(start, 5000, 5000, BW, BH), {
    x: BW - 200,
    y: BH - 100,
    w: 200,
    h: 100,
  });
});

test("resizeRect freeform: se drag grows, edges clamp to bounds", () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };
  const grown = resizeRect(start, "se", 50, 30, BW, BH, null);
  assert.deepEqual(grown, { x: 100, y: 100, w: 250, h: 130 });
  const clamped = resizeRect(start, "se", 5000, 5000, BW, BH, null);
  assert.deepEqual(clamped, { x: 100, y: 100, w: BW - 100, h: BH - 100 });
});

test("resizeRect freeform: collapsing drags stop at the minimum size", () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };
  const min = 24;
  const tiny = resizeRect(start, "nw", 5000, 5000, BW, BH, null, min);
  assert.equal(tiny.w, min);
  assert.equal(tiny.h, min);
  // anchored at the se corner
  assert.equal(tiny.x + tiny.w, 300);
  assert.equal(tiny.y + tiny.h, 200);
});

test("resizeRect aspect corner: keeps ratio, anchors the opposite corner", () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };
  const out = resizeRect(start, "se", 100, 0, BW, BH, 2);
  assert.ok(Math.abs(out.w / out.h - 2) < 1e-9);
  assert.equal(out.x, 100);
  assert.equal(out.y, 100);
});

test("resizeRect aspect corner: shrinks uniformly when bounds cut it off", () => {
  const start = { x: 700, y: 500, w: 50, h: 50 };
  const out = resizeRect(start, "se", 500, 500, BW, BH, 1);
  assert.ok(Math.abs(out.w / out.h - 1) < 1e-9);
  assert.ok(out.x + out.w <= BW + 1e-9);
  assert.ok(out.y + out.h <= BH + 1e-9);
});

test("resizeRect aspect edge: other axis follows, centered on the midline", () => {
  const start = { x: 300, y: 200, w: 200, h: 100 };
  const out = resizeRect(start, "e", 100, 0, BW, BH, 2);
  assert.equal(out.w, 300);
  assert.equal(out.h, 150);
  // vertical center preserved
  assert.equal(out.y + out.h / 2, 250);
});

test("resizeRect aspect edge: clamps the follower axis at the bounds", () => {
  const start = { x: 100, y: 10, w: 100, h: 50 }; // near the top edge
  const out = resizeRect(start, "e", 600, 0, BW, BH, 2);
  assert.ok(out.y >= 0);
  assert.ok(Math.abs(out.w / out.h - 2) < 1e-9);
  // midline preserved → height limited by distance to the top edge
  assert.equal(out.h, 70);
});

test("fitAspect: largest centered rect of the ratio inside the original", () => {
  const out = fitAspect({ x: 0, y: 0, w: 100, h: 100 }, 2, BW, BH);
  assert.deepEqual(out, { x: 0, y: 25, w: 100, h: 50 });
  const tall = fitAspect({ x: 200, y: 100, w: 100, h: 100 }, 0.5, BW, BH);
  assert.deepEqual(tall, { x: 225, y: 100, w: 50, h: 100 });
});
