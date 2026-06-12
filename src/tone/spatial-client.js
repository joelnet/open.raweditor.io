// Main-thread side of the presence analysis: hands the preview pixels to
// spatial-worker.js and resolves with the renderer-ready aux planes.
// Requests are serialized so a slow analysis for one image can't tangle
// with the next image's (callers token-guard staleness themselves).

export function createSpatialAnalyzer() {
  /** @type {Worker | null} */
  let worker = null;
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  return {
    /**
     * Analyze a preview image. The pixel buffer is cloned, not transferred
     * — the caller keeps using it (auto WB/tone statistics).
     * @param {{ pixels: Uint16Array, width: number, height: number }} img
     * @returns {Promise<import("../gl/renderer.js").PresenceAux>}
     */
    analyze(img) {
      if (!worker) {
        worker = new Worker(new URL("./spatial-worker.js", import.meta.url), {
          type: "module",
        });
      }
      const w = worker;
      const job = () =>
        new Promise((resolve, reject) => {
          /** @param {MessageEvent} e */
          w.onmessage = (e) => {
            if (e.data.type === "done") resolve(e.data.aux);
            else reject(new Error(e.data.message));
          };
          w.onerror = (e) =>
            reject(new Error(e.message || "spatial worker error"));
          w.postMessage({
            pixels: img.pixels,
            width: img.width,
            height: img.height,
          });
        });
      const p = chain.then(job, job);
      chain = p.catch(() => {});
      return /** @type {Promise<import("../gl/renderer.js").PresenceAux>} */ (
        p
      );
    },
  };
}
