// Export worker: applies the tone pipeline (pure JS mirror of the preview
// shader) to full-resolution decoded data and encodes a PNG or JPEG. Runs
// off the main thread; posts row progress between chunks.

import { toneMapRows } from "../tone/tone-math.js";

const CHUNK_ROWS = 256;

const ctx = /** @type {any} */ (self);

ctx.onmessage = async (/** @type {MessageEvent} */ e) => {
  const { image, settings, format } = e.data;
  try {
    const { width, height } = image;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += CHUNK_ROWS) {
      const end = Math.min(y + CHUNK_ROWS, height);
      toneMapRows(image, settings, out, y, end);
      ctx.postMessage({ type: "progress", done: end, total: height });
    }
    const canvas = new OffscreenCanvas(width, height);
    const c2d = canvas.getContext("2d");
    if (!c2d) throw new Error("OffscreenCanvas 2d context unavailable");
    c2d.putImageData(new ImageData(out, width, height), 0, 0);
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
