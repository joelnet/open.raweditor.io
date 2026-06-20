// Global before/after toggle. While "held" the preview renders with every
// adjustment neutralized (crop preserved, since the crop rect/geometry pass
// through the renderer independently of tone settings). Two entry points:
//
//   * Desktop: a small viewport button — press-and-hold to compare.
//   * Touch/pen: long-press the image itself (the button is hidden on
//     small viewports via styles.css).

const LONG_PRESS_MS = 400;
const LONG_PRESS_SLOP = 14; // px of drift before a hold counts as a drag

/**
 * @param {HTMLElement} viewport image pane the button attaches to
 * @param {HTMLCanvasElement} canvas the preview canvas the long-press listens on
 * @param {{ onToggle: () => void }} handlers fires whenever the state flips
 */
export function initCompare(viewport, canvas, { onToggle }) {
  let held = false;

  const btn = /** @type {HTMLButtonElement} */ (
    document.createElement("button")
  );
  btn.id = "compare-toggle";
  btn.type = "button";
  btn.hidden = true;
  btn.textContent = "BEFORE";
  btn.title = "Press and hold to compare to the original";
  btn.setAttribute("aria-label", "Press and hold to compare to the original");
  btn.setAttribute("aria-pressed", "false");
  viewport.append(btn);

  function setHeld(/** @type {boolean} */ on) {
    if (on === held) return;
    held = on;
    btn.classList.toggle("active", held);
    btn.setAttribute("aria-pressed", String(held));
    onToggle();
  }

  // --- button: press-and-hold for mouse/keyboard users ---

  let btnPointer = -1;
  function releaseBtn() {
    if (btnPointer >= 0 && btn.hasPointerCapture(btnPointer)) {
      btn.releasePointerCapture(btnPointer);
    }
    btnPointer = -1;
    setHeld(false);
  }
  btn.addEventListener("pointerdown", (e) => {
    if (btnPointer >= 0) return;
    e.preventDefault();
    btnPointer = e.pointerId;
    btn.setPointerCapture(e.pointerId);
    setHeld(true);
  });
  btn.addEventListener("pointerup", (e) => {
    if (e.pointerId === btnPointer) releaseBtn();
  });
  btn.addEventListener("pointercancel", (e) => {
    if (e.pointerId === btnPointer) releaseBtn();
  });
  btn.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      setHeld(true);
    }
  });
  btn.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setHeld(false);
    }
  });
  btn.addEventListener("blur", () => {
    if (btnPointer < 0) setHeld(false);
  });

  // --- canvas long-press: touch/pen gesture for mobile ---
  //
  // Coexists with zoom.js's pan/pinch: cancel the timer the moment the
  // finger drifts past the slop or a second pointer lands, so a real pan
  // never triggers the comparison.

  let pressTimer = 0;
  /** @type {{ id: number, x: number, y: number } | null} */
  let pressPointer = null;
  let canvasHeld = false;

  function cancelPress() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = 0;
    }
    pressPointer = null;
  }
  function endCanvasHold() {
    cancelPress();
    if (canvasHeld) {
      canvasHeld = false;
      setHeld(false);
    }
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    if (pressPointer) {
      // a second finger landed (pinch) — abort the hold gesture
      endCanvasHold();
      return;
    }
    pressPointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    pressTimer = window.setTimeout(() => {
      pressTimer = 0;
      if (!pressPointer) return;
      canvasHeld = true;
      setHeld(true);
    }, LONG_PRESS_MS);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!pressPointer || e.pointerId !== pressPointer.id || canvasHeld) return;
    const dx = e.clientX - pressPointer.x;
    const dy = e.clientY - pressPointer.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_SLOP) cancelPress();
  });

  canvas.addEventListener("pointerup", (e) => {
    if (pressPointer && e.pointerId === pressPointer.id) endCanvasHold();
  });
  canvas.addEventListener("pointercancel", (e) => {
    if (pressPointer && e.pointerId === pressPointer.id) endCanvasHold();
  });

  return {
    /** True while the preview should show the unedited original. */
    isBefore() {
      return held;
    },
    /** Hide the button when no image is loaded; reset state on close. */
    setHasImage(/** @type {boolean} */ has) {
      btn.hidden = !has;
      if (!has) {
        releaseBtn();
        endCanvasHold();
      }
    },
  };
}
