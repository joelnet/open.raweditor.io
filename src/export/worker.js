// Export worker: applies the tone pipeline (pure JS mirror of the preview
// shader) to full-resolution decoded data and encodes a PNG, JPEG, or
// 16-bit TIFF. Runs off the main thread; posts row progress between chunks.

import { toneMapRows, cropPixelRect } from "../tone/tone-math.js";
import { ZERO_GEOMETRY, orientedDims } from "../tone/geometry.js";
import { applyPresencePrepass } from "../tone/spatial.js";
import { encodeTiff16 } from "./tiff.js";

const CHUNK_ROWS = 256;
const MAX_EXPORT_DIMENSION = 32768;
const MAX_EXPORT_PIXELS = 150_000_000;

const ctx = /** @type {any} */ (self);

/**
 * @param {{ width?: number, height?: number } | null | undefined} targetSize
 * @param {{ w: number, h: number }} rect
 */
function normalizeTargetSize(targetSize, rect) {
  const width = Math.max(1, Math.round(targetSize?.width ?? rect.w));
  const height = Math.max(1, Math.round(targetSize?.height ?? rect.h));
  if (width > MAX_EXPORT_DIMENSION || height > MAX_EXPORT_DIMENSION) {
    throw new Error(`Export size must be ${MAX_EXPORT_DIMENSION}px or less`);
  }
  if (width * height > MAX_EXPORT_PIXELS) {
    throw new Error("Export size is too large");
  }
  return { width, height };
}

/**
 * Bilinear resize for 8-bit and 16-bit RGBA buffers.
 * @param {Uint8ClampedArray | Uint16Array} src
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Uint8ClampedArray | Uint16Array}
 */
function resizeRgba(src, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return src;
  const dst =
    src instanceof Uint16Array
      ? new Uint16Array(dstW * dstH * 4)
      : new Uint8ClampedArray(dstW * dstH * 4);
  const xScale = srcW / dstW;
  const yScale = srcH / dstH;
  const bias = dst instanceof Uint16Array ? 0.5 : 0;

  for (let y = 0; y < dstH; y++) {
    const sy = (y + 0.5) * yScale - 0.5;
    const y0 = Math.min(Math.max(Math.floor(sy), 0), srcH - 1);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const ty = Math.min(Math.max(sy - y0, 0), 1);
    for (let x = 0; x < dstW; x++) {
      const sx = (x + 0.5) * xScale - 0.5;
      const x0 = Math.min(Math.max(Math.floor(sx), 0), srcW - 1);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const tx = Math.min(Math.max(sx - x0, 0), 1);
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const dstAt = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * tx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * tx;
        dst[dstAt + c] = top + (bot - top) * ty + bias;
      }
    }
  }
  return dst;
}

ctx.onmessage = async (/** @type {MessageEvent} */ e) => {
  const { image, settings, format, crop, previewWidth, targetSize } = e.data;
  const geometry = e.data.geometry ?? ZERO_GEOMETRY;
  try {
    // The crop rect lives on the oriented (frame) pixel grid.
    const frame = orientedDims(geometry.orient, image.width, image.height);
    const rect = cropPixelRect(crop, frame.width, frame.height);
    const target = normalizeTargetSize(targetSize, rect);
    // Presence (texture/clarity/dehaze) folds into the linear data first
    // (the CPU counterpart of the shader's step 0). The buffer was
    // transferred, so mutating it in place is safe. The wavelet steps
    // scale by the full-res / preview ratio so the bands match what the
    // preview showed.
    const scale = previewWidth
      ? Math.max(1, Math.round(image.width / previewWidth))
      : 1;
    applyPresencePrepass(image, settings, scale, geometry);
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
    const resized = resizeRgba(
      out,
      rect.w,
      rect.h,
      target.width,
      target.height,
    );
    if (resized instanceof Uint16Array) {
      const blob = new Blob(
        [encodeTiff16(resized, target.width, target.height)],
        {
          type: "image/tiff",
        },
      );
      ctx.postMessage({ type: "done", blob });
      return;
    }
    const canvas = new OffscreenCanvas(target.width, target.height);
    const c2d = canvas.getContext("2d");
    if (!c2d) throw new Error("OffscreenCanvas 2d context unavailable");
    const rgba8 = new Uint8ClampedArray(resized);
    c2d.putImageData(new ImageData(rgba8, target.width, target.height), 0, 0);
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
