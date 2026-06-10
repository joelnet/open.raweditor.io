// Bottom status bar: file/details on the left, progress/errors on the right.

export function createStatus() {
  const fileEl = /** @type {HTMLElement} */ (
    document.getElementById("status-file")
  );
  const progressEl = /** @type {HTMLElement} */ (
    document.getElementById("status-progress")
  );

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
    },
  };
}
