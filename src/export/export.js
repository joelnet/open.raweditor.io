// Main-thread side of image export: hands the full-res decode to the export
// worker, reports progress, returns the encoded Blob.

export function createExporter() {
  /** @type {Worker | null} */
  let worker = null;

  return {
    /**
     * Tone-map and encode a decoded image, optionally windowed to a
     * normalized crop rect. The image's pixel buffer is transferred
     * (detached) — the caller must not reuse it.
     * @param {{ data: Uint16Array | Uint8Array, width: number, height: number,
     *           colors: number, bits: number }} image
     * @param {import("../tone/tone-math.js").ToneSettings} settings
     * @param {"png" | "jpeg"} format
     * @param {import("../tone/tone-math.js").CropRect | null} crop
     * @param {(done: number, total: number) => void} [onProgress]
     * @returns {Promise<Blob>}
     */
    exportImage(image, settings, format, crop, onProgress) {
      if (!worker) {
        worker = new Worker(new URL("./worker.js", import.meta.url), {
          type: "module",
        });
      }
      const w = worker;
      return new Promise((resolve, reject) => {
        /** @param {MessageEvent} e */
        w.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === "progress") onProgress?.(msg.done, msg.total);
          else if (msg.type === "done") resolve(msg.blob);
          else if (msg.type === "error") reject(new Error(msg.message));
        };
        w.onerror = (e) =>
          reject(new Error(e.message || "export worker error"));
        w.postMessage({ image, settings, format, crop }, [image.data.buffer]);
      });
    },
  };
}

/**
 * Trigger a browser download for a Blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Give the navigation a tick before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
