// Decode worker for already-developed bitmaps (JPEG, HEIC). Receives the
// file bytes, decodes to 8-bit sRGB RGBA, and converts to the linear-sRGB
// 16-bit RGB layout the rest of the app expects from LibRaw. Replies
// { type: "done", image, meta } with the pixel buffer transferred, or
// { type: "error", message }.
//
// JPEG decodes through createImageBitmap — every engine has a fast,
// color-managed, EXIF-oriented JPEG decoder. HEIC tries the same first
// (Safari decodes HEIC natively) and falls back to the libheif wasm build
// from libheif-js, loaded only when that happens so JPEG opens never pay
// for it. libheif applies the container's rotation but not its colour
// profile, so Display P3 files (every iPhone) get a gamut conversion in
// the linearize step.

import { isJpeg, isHeic, linearizeRgba8, P3_TO_SRGB } from "./bitmap.js";
import {
  exifFromJpeg,
  exifFromHeic,
  heicPrimaries,
  PRIMARIES_P3,
} from "./exif.js";

/**
 * Decode via the browser's own codecs into sRGB RGBA.
 * @param {Uint8Array<ArrayBuffer>} bytes
 * @returns {Promise<ImageData>}
 */
async function nativeDecode(bytes) {
  const blob = new Blob([bytes]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      imageOrientation: "from-image",
      colorSpaceConversion: "default",
    });
  } catch (err) {
    // Engines that predate the options dict reject it with a TypeError;
    // retry bare (those engines apply EXIF orientation on their own).
    if (!(err instanceof TypeError)) throw err;
    bitmap = await createImageBitmap(blob);
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx2d) throw new Error("no 2d canvas context in worker");
    ctx2d.drawImage(bitmap, 0, 0);
    return ctx2d.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** @type {Promise<any> | null} */
let libheifPromise = null;

/** Lazy-load the libheif wasm module: the glue is a code-split chunk, the
 * wasm a hashed asset fetched on demand (and runtime-cached by the service
 * worker — see vite.config.js). */
function loadLibheif() {
  libheifPromise ??= (async () => {
    const [{ default: factory }, { default: wasmUrl }] = await Promise.all([
      import("libheif-js/libheif-wasm/libheif.js"),
      import("libheif-js/libheif-wasm/libheif.wasm?url"),
    ]);
    const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
    const mod = /** @type {any} */ (factory({ wasmBinary }));
    await mod.ready;
    return mod;
  })();
  return libheifPromise;
}

/**
 * Decode a HEIC through libheif into RGBA.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ data: Uint8ClampedArray, width: number, height: number }>}
 */
async function heifDecode(bytes) {
  const libheif = await loadLibheif();
  const decoder = new libheif.HeifDecoder();
  const images = /** @type {any[]} */ (decoder.decode(bytes));
  if (!images?.length) throw new Error("no image in HEIC file");
  try {
    const image = images[0]; // the primary image comes first
    const width = image.get_width();
    const height = image.get_height();
    const target = {
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    };
    await new Promise((resolve, reject) => {
      image.display(target, (/** @type {unknown} */ ok) => {
        if (ok) resolve(undefined);
        else reject(new Error("HEIC decode failed"));
      });
    });
    return target;
  } finally {
    for (const image of images) image.free();
  }
}

const ctx = /** @type {any} */ (self);

ctx.onmessage = async (/** @type {MessageEvent} */ e) => {
  try {
    const bytes = /** @type {Uint8Array<ArrayBuffer>} */ (e.data.bytes);
    /** @type {{ data: Uint8Array | Uint8ClampedArray, width: number,
     *           height: number }} */
    let rgba;
    /** @type {import("./exif.js").ExifMeta} */
    let exif;
    /** @type {number[] | null} */
    let matrix = null;
    if (isJpeg(bytes)) {
      exif = exifFromJpeg(bytes);
      rgba = await nativeDecode(bytes);
    } else if (isHeic(bytes)) {
      exif = exifFromHeic(bytes);
      try {
        rgba = await nativeDecode(bytes); // Safari: color-managed to sRGB
      } catch {
        rgba = await heifDecode(bytes);
        if (heicPrimaries(bytes) === PRIMARIES_P3) matrix = P3_TO_SRGB;
      }
    } else {
      throw new Error("not a JPEG or HEIC file");
    }
    const image = linearizeRgba8(rgba, matrix);
    const meta = {
      camera_make: exif?.make ?? "",
      camera_model: exif?.model ?? "",
      width: image.width,
      height: image.height,
      raw_width: image.width,
      raw_height: image.height,
      iso_speed: exif?.iso ?? 0,
      shutter: exif?.shutter ?? 0,
      aperture: exif?.aperture ?? 0,
      focal_len: exif?.focalLen ?? 0,
    };
    ctx.postMessage({ type: "done", image, meta }, [image.data.buffer]);
  } catch (err) {
    ctx.postMessage({
      type: "error",
      message: /** @type {any} */ (err)?.message ?? String(err),
    });
  }
};
