// Decode worker for JXL-compressed DNGs (DNG 1.7 — recent Samsung/Apple
// phone raws), which libraw-wasm cannot unpack. Receives the file bytes,
// decodes each JXL tile/strip through the libjxl wasm module (built by
// wasm/jxl/build.sh), assembles the LinearRaw mosaic, and develops it into
// the linear-sRGB 16-bit RGB layout the rest of the app expects from
// LibRaw. Replies { type: "done", image, meta } with the pixel buffer
// transferred, or { type: "error", message }.

import { parseJxlDng } from "./dng.js";
import { developLinearRgb, orientedSize } from "./dng-color.js";
// Generated emscripten glue; the wasm itself is fetched from /jxl/ at
// runtime (public/ asset, cached by the service worker's runtime route).
// Its filename carries a content hash so that cache can never hand new
// glue an old wasm.
import createJxlModule from "./jxl/jxl-module.mjs";
import WASM_FILE from "./jxl/wasm-name.js";

/** @type {Promise<any> | null} */
let modulePromise = null;

function loadModule() {
  modulePromise ??= createJxlModule({
    locateFile: () => `/jxl/${WASM_FILE}`,
  });
  return modulePromise;
}

/**
 * Reject DNG features this developer would render incorrectly rather than
 * produce wrong colors or scrambled pixels. None of the phone JXL DNGs
 * this path exists for use any of them.
 * @param {import("./dng.js").JxlDng} dng
 */
function checkSupported(dng) {
  /** @param {string} what */
  const unsupported = (what) => {
    throw new Error(`unsupported JXL DNG layout (${what})`);
  };
  if (dng.samplesPerPixel !== 3) {
    // A mosaic (CFA) JXL DNG would need a demosaicer.
    unsupported(`${dng.samplesPerPixel} samples/px`);
  }
  if (dng.photometric !== 34892) unsupported("not LinearRaw");
  if (dng.sampleFormat !== 1) unsupported("non-integer samples");
  if (dng.hasLinearizationTable) unsupported("linearization table");
  if (dng.blackLevel.some((b) => b !== dng.blackLevel[0])) {
    unsupported("patterned black level");
  }
  const a = dng.activeArea;
  if (
    a &&
    (a[0] !== 0 || a[1] !== 0 || a[2] !== dng.height || a[3] !== dng.width)
  ) {
    unsupported("cropping ActiveArea");
  }
  if (dng.subTileBlockSize?.some((v) => v !== 1)) {
    unsupported("sub-tile blocks");
  }
  if (dng.rowInterleaveFactor !== 1 || dng.columnInterleaveFactor !== 1) {
    unsupported("interleaved rows/columns");
  }
}

/**
 * Decode one JXL codestream into interleaved u16 samples.
 * @param {any} mod emscripten module
 * @param {Uint8Array} bytes
 * @returns {{ data: Uint16Array, width: number, height: number, channels: number }}
 */
function decodeCodestream(mod, bytes) {
  const ptr = mod._malloc(bytes.length);
  if (!ptr) throw new Error("out of memory for JXL input");
  mod.HEAPU8.set(bytes, ptr);
  try {
    const rc = mod._jxl_decode(ptr, bytes.length);
    if (rc !== 0) throw new Error(`JXL decode failed (${rc})`);
    const width = mod._jxl_width();
    const height = mod._jxl_height();
    const channels = mod._jxl_channels();
    const pixels = mod._jxl_pixels();
    const count = width * height * channels;
    // Copy out of the wasm heap before releasing the result.
    const data = new Uint16Array(mod.HEAPU16.buffer, pixels, count).slice();
    mod._jxl_release();
    return { data, width, height, channels };
  } finally {
    mod._free(ptr);
  }
}

/**
 * @param {import("./dng.js").JxlDng} dng
 * @param {Uint8Array} fileBytes
 * @param {any} mod
 * @returns {Uint16Array} interleaved RGB, dng.width × dng.height
 */
function assembleTiles(dng, fileBytes, mod) {
  const { width, height, tiles } = dng;
  /** @type {Uint16Array | null} */
  let full = null;
  for (const tile of tiles) {
    if (!tile.byteCount || tile.offset + tile.byteCount > fileBytes.length) {
      // A zero-filled hole would look like a successful decode.
      throw new Error("malformed JXL DNG tile table");
    }
    const slice = fileBytes.subarray(tile.offset, tile.offset + tile.byteCount);
    const t = decodeCodestream(mod, slice);
    if (t.channels !== 3) {
      throw new Error(`unsupported JXL raw layout (${t.channels} channels)`);
    }
    // Samsung-style single full strip: the decode IS the image.
    if (tiles.length === 1 && t.width === width && t.height === height) {
      return t.data;
    }
    full ??= new Uint16Array(width * height * 3);
    // Blit, clamping tiles that overhang the right/bottom edges.
    const copyW = Math.min(t.width, width - tile.x);
    const copyH = Math.min(t.height, height - tile.y);
    for (let row = 0; row < copyH; row++) {
      const src = row * t.width * 3;
      const dst = ((tile.y + row) * width + tile.x) * 3;
      full.set(t.data.subarray(src, src + copyW * 3), dst);
    }
  }
  if (!full) throw new Error("JXL DNG contains no image data");
  return full;
}

const ctx = /** @type {any} */ (self);

ctx.onmessage = async (/** @type {MessageEvent} */ e) => {
  try {
    const bytes = /** @type {Uint8Array} */ (e.data.bytes);
    const dng = parseJxlDng(bytes);
    if (!dng) throw new Error("not a JXL-compressed DNG");
    checkSupported(dng);
    const mod = await loadModule();
    const raw = assembleTiles(dng, bytes, mod);
    const image = developLinearRgb(raw, dng);
    const size = orientedSize(dng.orientation, dng.width, dng.height);
    const meta = {
      camera_make: dng.make,
      camera_model: dng.model,
      width: size.width,
      height: size.height,
      raw_width: size.width,
      raw_height: size.height,
      iso_speed: dng.exif.iso,
      shutter: dng.exif.shutter,
      aperture: dng.exif.aperture,
      focal_len: dng.exif.focalLen,
    };
    ctx.postMessage({ type: "done", image, meta }, [image.data.buffer]);
  } catch (err) {
    ctx.postMessage({
      type: "error",
      message: /** @type {any} */ (err)?.message ?? String(err),
    });
  }
};
