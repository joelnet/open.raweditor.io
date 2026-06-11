// Export worker: applies the tone pipeline (pure JS mirror of the preview
// shader) to full-resolution decoded data and encodes a PNG or JPEG. Runs
// off the main thread; posts row progress between chunks.

import { toneMapRows, cropPixelRect } from "../tone/tone-math.js";
import { ZERO_GEOMETRY, orientedDims } from "../tone/geometry.js";

const CHUNK_ROWS = 256;

const ctx = /** @type {any} */ (self);

ctx.onmessage = async (/** @type {MessageEvent} */ e) => {
  const { image, settings, format, crop } = e.data;
  const geometry = e.data.geometry ?? ZERO_GEOMETRY;
  try {
    // The crop rect lives on the oriented (frame) pixel grid.
    const frame = orientedDims(geometry.orient, image.width, image.height);
    const rect = cropPixelRect(crop, frame.width, frame.height);
    const out = new Uint8ClampedArray(rect.w * rect.h * 4);
    for (let y = 0; y < rect.h; y += CHUNK_ROWS) {
      const end = Math.min(y + CHUNK_ROWS, rect.h);
      toneMapRows(image, settings, out, y, end, rect, geometry);
      ctx.postMessage({ type: "progress", done: end, total: rect.h });
    }
    const canvas = new OffscreenCanvas(rect.w, rect.h);
    const c2d = canvas.getContext("2d");
    if (!c2d) throw new Error("OffscreenCanvas 2d context unavailable");
    c2d.putImageData(new ImageData(out, rect.w, rect.h), 0, 0);
    const blob = await canvas.convertToBlob(
      format === "jpeg"
        ? { type: "image/jpeg", quality: 0.92 }
        : { type: "image/png" },
    );
    ctx.postMessage({ type: "done", blob });
  } catch (err) {
    ctx.postMessage({
      type: "error",
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }
};
