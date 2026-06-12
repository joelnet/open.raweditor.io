// Export worker: applies the tone pipeline (pure JS mirror of the preview
// shader) to full-resolution decoded data and encodes a PNG, JPEG, or
// 16-bit TIFF. Runs off the main thread; posts row progress between chunks.

import { toneMapRows, cropPixelRect } from "../tone/tone-math.js";
import { ZERO_GEOMETRY, orientedDims } from "../tone/geometry.js";
import { applyPresencePrepass } from "../tone/spatial.js";
import { encodeTiff16 } from "./tiff.js";

const CHUNK_ROWS = 256;

const ctx = /** @type {any} */ (self);

ctx.onmessage = async (/** @type {MessageEvent} */ e) => {
  const { image, settings, format, crop, previewWidth } = e.data;
  const geometry = e.data.geometry ?? ZERO_GEOMETRY;
  try {
    // Presence (texture/clarity/dehaze) folds into the linear data first
    // (the CPU counterpart of the shader's step 0). The buffer was
    // transferred, so mutating it in place is safe. The wavelet steps
    // scale by the full-res / preview ratio so the bands match what the
    // preview showed.
    const scale = previewWidth
      ? Math.max(1, Math.round(image.width / previewWidth))
      : 1;
    applyPresencePrepass(image, settings, scale);
    // The crop rect lives on the oriented (frame) pixel grid.
    const frame = orientedDims(geometry.orient, image.width, image.height);
    const rect = cropPixelRect(crop, frame.width, frame.height);
    // TIFF keeps 16 bits per sample; the canvas encoders are 8-bit.
    const out =
      format === "tiff"
        ? new Uint16Array(rect.w * rect.h * 4)
        : new Uint8ClampedArray(rect.w * rect.h * 4);
    for (let y = 0; y < rect.h; y += CHUNK_ROWS) {
      const end = Math.min(y + CHUNK_ROWS, rect.h);
      toneMapRows(image, settings, out, y, end, rect, geometry);
      ctx.postMessage({ type: "progress", done: end, total: rect.h });
    }
    if (out instanceof Uint16Array) {
      const blob = new Blob([encodeTiff16(out, rect.w, rect.h)], {
        type: "image/tiff",
      });
      ctx.postMessage({ type: "done", blob });
      return;
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
