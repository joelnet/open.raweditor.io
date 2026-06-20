// Bottom status bar: file/details on the left, progress/errors on the right,
// plus a thin progress bar pinned to the top edge for long-running work.

export function createStatus() {
  const fileEl = /** @type {HTMLElement} */ (
    document.getElementById("status-file")
  );
  const progressEl = /** @type {HTMLElement} */ (
    document.getElementById("status-progress")
  );
  const barEl = /** @type {HTMLElement} */ (
    document.getElementById("status-bar-progress")
  );
  const fillEl = /** @type {HTMLElement} */ (
    document.getElementById("status-bar-progress-fill")
  );

  const clearBar = () => {
    barEl.classList.remove("visible", "busy");
    barEl.removeAttribute("aria-valuenow");
    barEl.setAttribute("aria-hidden", "true");
    fillEl.style.width = "0";
  };

  return {
    /** @param {string} text */
    setFile(text) {
      fileEl.classList.remove("error");
      fileEl.textContent = text;
    },
    /** @param {string} text */
    setProgress(text) {
      progressEl.classList.remove("error");
      progressEl.textContent = text;
    },
    /** @param {string} text */
    setError(text) {
      progressEl.classList.add("error");
      progressEl.textContent = text;
      clearBar();
    },
    /** Indeterminate progress: animated sweep across the bar.
     * @param {boolean} busy */
    setBusy(busy) {
      if (busy) {
        barEl.classList.add("visible", "busy");
        barEl.setAttribute("aria-hidden", "false");
        barEl.removeAttribute("aria-valuenow");
        fillEl.style.width = "";
      } else {
        clearBar();
      }
    },
    /** Determinate progress: clamped to 0..1. Switches off busy mode.
     * @param {number} value */
    setProgressValue(value) {
      const clamped = Math.max(0, Math.min(1, value));
      barEl.classList.add("visible");
      barEl.classList.remove("busy");
      barEl.setAttribute("aria-hidden", "false");
      barEl.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
      fillEl.style.width = `${clamped * 100}%`;
    },
    clearProgressBar() {
      clearBar();
    },
  };
}
