// Thin wrapper around libraw-wasm. The package already runs LibRaw inside
// its own Web Worker (plus em-pthread workers), so decode never blocks the
// main thread; this wrapper adds copy-on-open, call serialization, settings
// defaults, and teardown.
//
// Two families of files never reach LibRaw, and are detected up front and
// routed to one-shot workers that return the same { meta, image } shape:
//
//   - DNGs whose raw payload is JPEG XL compressed (DNG 1.7 — recent
//     Samsung and Apple phone cameras). LibRaw only decodes those through
//     the Adobe DNG SDK, which the wasm build lacks → src/decode/jxl-worker.js
//   - Already-developed bitmaps (JPEG, HEIC) → src/decode/bitmap-worker.js

import LibRaw from "libraw-wasm";
import { isJxlDng } from "./dng.js";
import { isBitmapImage } from "./bitmap.js";

/**
 * Defaults shared by preview and export decodes: camera white balance,
 * 16-bit samples, sRGB primaries, linear transfer (gamm [1,1]) so the tone
 * pipeline operates on linear light. See tone/constants.js INPUT_TRANSFER.
 */
const BASE_SETTINGS = {
  useCameraWb: true,
  outputBps: 16,
  outputColor: 1,
  // LibRaw's params.gamm is double[6]; the wrapper ignores shorter arrays.
  // [1, 1, ...] disables the output gamma curve → linear data.
  gamm: /** @type {[number, number]} */ (
    /** @type {unknown} */ ([1, 1, 0, 0, 0, 0])
  ),
};

/**
 * @typedef {{ meta: import("libraw-wasm").Metadata,
 *             image: import("libraw-wasm").RawImageData,
 *             decodeMs: number }} DecodeResult
 */

export class Decoder {
  /** @type {LibRaw | null} */
  #raw = null;
  /** @type {{ worker: Worker, reject: (err: Error) => void } | null} */
  #oneShot = null;
  /** @type {Promise<unknown>} */
  #queue = Promise.resolve();

  /**
   * Decode a RAW file. Safe to call repeatedly; calls are serialized because
   * the libraw-wasm worker handles one request at a time.
   * @param {Uint8Array} bytes original file bytes; not consumed (libraw-wasm
   *   transfers the buffer it receives, so a copy is passed instead)
   * @param {import("libraw-wasm").LibRawSettings} [settings]
   * @returns {Promise<DecodeResult>}
   */
  decode(bytes, settings = {}) {
    return this.decodeExact(bytes, { ...BASE_SETTINGS, ...settings });
  }

  /**
   * Decode with exactly the given settings — no defaults merged in.
   * @param {Uint8Array} bytes
   * @param {import("libraw-wasm").LibRawSettings} settings
   * @returns {Promise<DecodeResult>}
   */
  decodeExact(bytes, settings) {
    const run = this.#queue.then(async () => {
      // Settings don't apply on the worker routes: both always develop the
      // full image to the same linear/sRGB target the defaults ask LibRaw
      // for, and halfSize is only a speed hint.
      if (isBitmapImage(bytes)) {
        const t0 = performance.now();
        const { meta, image } = await this.#decodeInWorker(
          new Worker(new URL("./bitmap-worker.js", import.meta.url), {
            type: "module",
          }),
          bytes,
        );
        return { meta, image, decodeMs: performance.now() - t0 };
      }
      if (isJxlDng(bytes)) {
        const t0 = performance.now();
        const { meta, image } = await this.#decodeInWorker(
          new Worker(new URL("./jxl-worker.js", import.meta.url), {
            type: "module",
          }),
          bytes,
        );
        return { meta, image, decodeMs: performance.now() - t0 };
      }
      // Fresh instance (fresh worker + wasm) per decode, disposed right
      // after: each instance holds hundreds of MB of wasm memory, which
      // matters on phones.
      const raw = new LibRaw();
      this.#raw = raw;
      try {
        const t0 = performance.now();
        await raw.open(bytes.slice(), settings);
        const meta = await raw.metadata(true);
        const image = await raw.imageData();
        if (!meta || !image) throw new Error("decode produced no image data");
        return { meta, image, decodeMs: performance.now() - t0 };
      } finally {
        raw.dispose();
        if (this.#raw === raw) this.#raw = null;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Run a one-shot decode worker (spawned per decode and torn down after,
   * mirroring the fresh-LibRaw-per-decode policy above). Tracked so
   * terminate() can cancel it mid-flight. The Worker is constructed at the
   * call site so Vite can statically resolve its URL.
   * @param {Worker} worker
   * @param {Uint8Array} bytes original file bytes; not consumed
   * @returns {Promise<{ meta: any, image: any }>}
   */
  #decodeInWorker(worker, bytes) {
    return new Promise((resolve, reject) => {
      this.#oneShot = { worker, reject };
      const settle = () => {
        worker.terminate();
        if (this.#oneShot?.worker === worker) this.#oneShot = null;
      };
      worker.onmessage = (e) => {
        settle();
        if (e.data.type === "done") {
          resolve({ meta: e.data.meta, image: e.data.image });
        } else {
          reject(new Error(e.data.message ?? "decode failed"));
        }
      };
      worker.onerror = (e) => {
        settle();
        reject(new Error(e.message || "decode worker error"));
      };
      const copy = bytes.slice();
      worker.postMessage({ bytes: copy }, [copy.buffer]);
    });
  }

  /** Tear down the underlying workers and wasm memory. */
  terminate() {
    this.#raw?.dispose();
    this.#raw = null;
    if (this.#oneShot) {
      this.#oneShot.worker.terminate();
      this.#oneShot.reject(new Error("decoder terminated"));
      this.#oneShot = null;
    }
    this.#queue = Promise.resolve();
  }
}
