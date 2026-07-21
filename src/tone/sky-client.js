// Main-thread side of sky detection: hands the neutral preview pixels to
// sky-worker.js and resolves with a brush-coverage-ready sky mask, or null
// when the model finds no sky. The worker (and with it the wasm module +
// 2.2MB model download) spins up lazily on the first request. Requests are
// serialized like the spatial analyzer's; callers guard staleness (a file
// opened mid-detection) themselves.

export function createSkyDetector() {
  /** @type {Worker | null} */
  let worker = null;
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  return {
    /**
     * Detect the sky in a preview image. The pixel buffer is cloned, not
     * transferred — the caller keeps using it. The straighten angle is
     * ignored (statistics policy); orient/flips map the mask into frame
     * space.
     * @param {{ pixels: Uint16Array, width: number, height: number }} img
     * @param {import("./geometry.js").Geometry} geometry
     * @returns {Promise<{ coverage: Uint8Array, w: number, h: number } | null>}
     */
    detect(img, geometry) {
      if (!worker) {
        worker = new Worker(new URL("./sky-worker.js", import.meta.url), {
          type: "module",
        });
      }
      const w = worker;
      const job = () =>
        new Promise((resolve, reject) => {
          /** @param {MessageEvent} e */
          w.onmessage = (e) => {
            if (e.data.type === "done") {
              resolve({
                coverage: e.data.coverage,
                w: e.data.w,
                h: e.data.h,
              });
            } else if (e.data.type === "none") resolve(null);
            else reject(new Error(e.data.message));
          };
          w.onerror = (e) => reject(new Error(e.message || "sky worker error"));
          w.postMessage({
            pixels: img.pixels,
            width: img.width,
            height: img.height,
            orient: geometry.orient,
            flipH: geometry.flipH,
            flipV: geometry.flipV,
          });
        });
      const p = chain.then(job, job);
      chain = p.catch(() => {});
      return /** @type {Promise<{ coverage: Uint8Array, w: number, h: number } | null>} */ (
        p
      );
    },
  };
}
