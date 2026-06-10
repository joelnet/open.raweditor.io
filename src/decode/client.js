// Thin wrapper around libraw-wasm. The package already runs LibRaw inside
// its own Web Worker (plus em-pthread workers), so decode never blocks the
// main thread; this wrapper adds copy-on-open, call serialization, settings
// defaults, and teardown.

import LibRaw from "libraw-wasm";

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
      // Fresh instance (fresh worker + wasm) per decode: reusing open() on
      // one instance returns stale/alternating image data (libraw-wasm 1.3.0).
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
        terminateWorker(raw);
        if (this.#raw === raw) this.#raw = null;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Tear down the underlying workers and wasm memory. */
  terminate() {
    if (this.#raw) terminateWorker(this.#raw);
    this.#raw = null;
    this.#queue = Promise.resolve();
  }
}

/** @param {LibRaw} raw */
function terminateWorker(raw) {
  const w = /** @type {{ worker?: Worker }} */ (/** @type {unknown} */ (raw))
    .worker;
  w?.terminate();
}
