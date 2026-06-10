// Draggable horizontal divider for the mobile stacked layout. Dragging
// updates the --split custom property (image pane's share of #app height);
// the position is clamped and remembered across sessions.

const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;
const STORAGE_KEY = "raw-editor.split";

/**
 * @param {{ onResize: () => void }} handlers
 */
export function initDivider({ onResize }) {
  const divider = /** @type {HTMLElement} */ (
    document.getElementById("divider")
  );
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));

  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (saved >= MIN_SPLIT && saved <= MAX_SPLIT) {
    app.style.setProperty("--split", `${saved * 100}%`);
  }

  /** @param {PointerEvent} e */
  function move(e) {
    const box = app.getBoundingClientRect();
    if (box.height === 0) return;
    const split = Math.min(
      Math.max((e.clientY - box.top) / box.height, MIN_SPLIT),
      MAX_SPLIT,
    );
    app.style.setProperty("--split", `${split * 100}%`);
    onResize();
  }

  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      divider.setPointerCapture(e.pointerId);
    } catch {
      // non-capturable pointer (synthetic events); drag still works
    }
    divider.classList.add("dragging");
    move(e);
  });
  divider.addEventListener("pointermove", (e) => {
    if (divider.classList.contains("dragging")) move(e);
  });
  const end = () => {
    if (!divider.classList.contains("dragging")) return;
    divider.classList.remove("dragging");
    const current = parseFloat(app.style.getPropertyValue("--split"));
    if (!Number.isNaN(current)) {
      localStorage.setItem(STORAGE_KEY, String(current / 100));
    }
    onResize();
  };
  divider.addEventListener("pointerup", end);
  divider.addEventListener("pointercancel", end);
}
