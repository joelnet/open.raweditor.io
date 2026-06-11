import test from "node:test";
import assert from "node:assert/strict";
import { cropPixelRect, toneMapRows, ZERO_SETTINGS } from "../tone-math.js";

test("cropPixelRect: null or full-frame crop is the whole image", () => {
  assert.deepEqual(cropPixelRect(null, 4000, 3000), {
    x: 0,
    y: 0,
    w: 4000,
    h: 3000,
  });
  assert.deepEqual(cropPixelRect({ x: 0, y: 0, w: 1, h: 1 }, 4000, 3000), {
    x: 0,
    y: 0,
    w: 4000,
    h: 3000,
  });
});

test("cropPixelRect: maps a normalized rect onto the pixel grid", () => {
  assert.deepEqual(
    cropPixelRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 4000, 3000),
    { x: 1000, y: 750, w: 2000, h: 1500 },
  );
});

test("cropPixelRect: degenerate rects stay at least 1×1 and inside", () => {
  const tiny = cropPixelRect(
    { x: 0.5, y: 0.5, w: 0.00001, h: 0.00001 },
    100,
    100,
  );
  assert.ok(tiny.w >= 1 && tiny.h >= 1);
  const edge = cropPixelRect(
    { x: 0.999, y: 0.999, w: 0.01, h: 0.01 },
    100,
    100,
  );
  assert.ok(edge.x + edge.w <= 100);
  assert.ok(edge.y + edge.h <= 100);
  assert.ok(edge.w >= 1 && edge.h >= 1);
});

test("toneMapRows with a rect matches the same window of a full-frame pass", () => {
  const width = 6;
  const height = 4;
  const colors = 3;
  const data = new Uint16Array(width * height * colors);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2749) % 65536;
  const image = { data, width, height, colors, bits: 16 };

  const full = new Uint8ClampedArray(width * height * 4);
  toneMapRows(image, ZERO_SETTINGS, full, 0, height);

  const rect = { x: 2, y: 1, w: 3, h: 2 };
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  toneMapRows(image, ZERO_SETTINGS, out, 0, rect.h, rect);

  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const got = out.subarray((y * rect.w + x) * 4, (y * rect.w + x) * 4 + 4);
      const srcIdx = ((y + rect.y) * width + (x + rect.x)) * 4;
      const want = full.subarray(srcIdx, srcIdx + 4);
      assert.deepEqual([...got], [...want], `pixel (${x},${y})`);
    }
  }
});

test("toneMapRows with a rect honors the row range for chunking", () => {
  const width = 4;
  const height = 4;
  const data = new Uint16Array(width * height * 3).fill(20000);
  const image = { data, width, height, colors: 3, bits: 16 };
  const rect = { x: 1, y: 1, w: 2, h: 3 };

  const whole = new Uint8ClampedArray(rect.w * rect.h * 4);
  toneMapRows(image, ZERO_SETTINGS, whole, 0, rect.h, rect);

  const chunked = new Uint8ClampedArray(rect.w * rect.h * 4);
  toneMapRows(image, ZERO_SETTINGS, chunked, 0, 2, rect);
  toneMapRows(image, ZERO_SETTINGS, chunked, 2, rect.h, rect);

  assert.deepEqual([...chunked], [...whole]);
});
