// Custom double-tap/double-click detector. The native `dblclick` event is
// unreliable on mobile when the target captures pointer events (notably
// <input type="range">: the slider's touch handling absorbs events and the
// browser never synthesizes a dblclick). This pointer-based detector works
// the same on mouse and touch.

const TAP_MS = 350;
const TAP_SLOP = 18; // px of drift before a touch stops counting as a tap

/**
 * Fire `handler` when the element receives two taps within {@link TAP_MS},
 * neither of which moved more than {@link TAP_SLOP} from its pointerdown.
 * @param {HTMLElement} el
 * @param {() => void} handler
 */
export function onDoubleTap(el, handler) {
  let downX = 0;
  let downY = 0;
  let moved = false;
  let lastT = 0;
  let lastX = 0;
  let lastY = 0;

  el.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    downY = e.clientY;
    moved = false;
  });
  el.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP) {
      moved = true;
    }
  });
  el.addEventListener("pointerup", (e) => {
    if (moved) {
      lastT = 0;
      return;
    }
    const now = performance.now();
    const near =
      Math.hypot(e.clientX - lastX, e.clientY - lastY) < TAP_SLOP * 2;
    if (now - lastT < TAP_MS && near) {
      lastT = 0;
      handler();
    } else {
      lastT = now;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  });
}
