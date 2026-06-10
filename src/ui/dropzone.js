// File intake: browse button, hidden file input, and drag-and-drop over
// the whole window. Only .arw/.raf files are accepted.

const ACCEPTED = /\.(arw|raf)$/i;

/**
 * @param {{ onFile: (file: File) => void, onReject: (name: string) => void }} handlers
 */
export function initDropzone({ onFile, onReject }) {
  const dropzone = /** @type {HTMLElement} */ (
    document.getElementById("dropzone")
  );
  const input = /** @type {HTMLInputElement} */ (
    document.getElementById("file-input")
  );
  const pick = /** @type {HTMLButtonElement} */ (
    document.getElementById("pick-file")
  );

  /** @param {File | undefined | null} file */
  function handle(file) {
    if (!file) return;
    if (!ACCEPTED.test(file.name)) {
      onReject(file.name);
      return;
    }
    onFile(file);
  }

  pick.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    handle(input.files?.[0]);
    input.value = ""; // allow re-opening the same file
  });

  // Drag-and-drop anywhere in the window.
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    dropzone.classList.add("dragover");
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropzone.classList.remove("dragover");
    }
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove("dragover");
    handle(e.dataTransfer?.files?.[0]);
  });

  return {
    /** @param {boolean} visible */
    setVisible(visible) {
      dropzone.classList.toggle("hidden", !visible);
    },
  };
}
