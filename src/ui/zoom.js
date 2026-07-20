// Zoom & pan for the preview canvas. One pointer-events controller serves
// both input worlds: wheel zoom (cursor-anchored) + drag pan + double-click
// on fine pointers; pinch zoom + drag pan + double-tap on touch. Zoom level
// 1 is "fit"; the view is a same-aspect sub-window of the crop rect, so the
// canvas element never changes size while zooming — only the shader's UV
// window moves. A small badge shows the level and resets to fit.

const MAX_ZOOM = 8;
const WHEEL_SENSITIVITY = 0.0015;
const TAP_MS = 350; // double-tap window
const TAP_SLOP = 24; // px of drift before a touch stops counting as a tap

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} viewport element the zoom badge attaches to
 * @param {{
 *   getBounds: () => import("../gl/renderer.js").ViewRect,
 *   getImageSize: () => { width: number, height: number } | null,
 *   onChange: () => void,
 * }} opts getBounds: the crop rect the view must stay inside
 */
export function initZoom(
  canvas,
  viewport,
  { getBounds, getImageSize, onChange },
) {
  let zoom = 1;
  let cx = 0.5; // view center, image UV
  let cy = 0.5;
  let enabled = false;

  const badge = /** @type {HTMLButtonElement} */ (
    document.createElement("button")
  );
  badge.id = "zoom-badge";
  badge.type = "button";
  badge.title = "Reset zoom to fit";
  viewport.append(badge);
  badge.addEventListener("click", () => {
    reset();
    onChange();
  });

  /**
   * Current view rect: the crop bounds at fit, a clamped sub-window when
   * zoomed. Also re-centers cx/cy after clamping so pans never go dead.
   * @returns {import("../gl/renderer.js").ViewRect}
   */
  function view() {
    const b = getBounds();
    if (zoom <= 1) return { ...b };
    const w = b.w / zoom;
    const h = b.h / zoom;
    const x = clamp(cx - w / 2, b.x, b.x + b.w - w);
    const y = clamp(cy - h / 2, b.y, b.y + b.h - h);
    cx = x + w / 2;
    cy = y + h / 2;
    return { x, y, w, h };
  }

  function changed() {
    badge.textContent = `${zoom.toFixed(1)}×`;
    const zoomed = zoom > 1.001;
    badge.classList.toggle("show", zoomed);
    canvas.classList.toggle("zoomed", zoomed);
    onChange();
  }

  /**
   * Zoom to `next`, keeping the image point under (clientX, clientY) fixed.
   * @param {number} next
   * @param {number} clientX
   * @param {number} clientY
   */
  function zoomTo(next, clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const fx = clamp((clientX - r.left) / r.width, 0, 1);
    const fy = clamp((clientY - r.top) / r.height, 0, 1);
    const v = view();
    const px = v.x + fx * v.w; // image point under the pointer
    const py = v.y + fy * v.h;
    zoom = clamp(next, 1, MAX_ZOOM);
    const b = getBounds();
    cx = px - (fx - 0.5) * (b.w / zoom);
    cy = py - (fy - 0.5) * (b.h / zoom);
    changed();
  }

  /**
   * Pan by a screen-pixel delta (drag direction, image follows the finger).
   * @param {number} dxPx
   * @param {number} dyPx
   */
  function panBy(dxPx, dyPx) {
    if (zoom <= 1) return;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const v = view();
    cx -= (dxPx / r.width) * v.w;
    cy -= (dyPx / r.height) * v.h;
    changed();
  }

  function reset() {
    zoom = 1;
    pointers.clear();
    pinchDist = 0;
    badge.classList.remove("show");
    canvas.classList.remove("zoomed", "panning");
  }

  /**
   * Double-click / double-tap: toggle between fit and 1:1 texels of the
   * sharpest loaded texture (with a 2× floor so small images still
   * visibly jump).
   * @param {number} clientX
   * @param {number} clientY
   */
  function toggleFit(clientX, clientY) {
    if (zoom > 1.001) {
      zoomTo(1, clientX, clientY);
      return;
    }
    const img = getImageSize();
    if (!img || canvas.width === 0) return;
    const b = getBounds();
    zoomTo(Math.max((b.w * img.width) / canvas.width, 2), clientX, clientY);
  }

  // --- pointers: 1 = pan (and tap detection), 2 = pinch ---

  /** @type {Map<number, { x: number, y: number, downX: number, downY: number }>} */
  const pointers = new Map();
  let pinchDist = 0;
  let moved = false;
  let lastTap = { t: 0, x: 0, y: 0 };

  canvas.addEventListener("pointerdown", (e) => {
    if (!enabled) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // non-capturable pointer (synthetic events); drag still works
    }
    pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      downX: e.clientX,
      downY: e.clientY,
    });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    } else if (zoom > 1.001) {
      canvas.classList.add("panning");
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(p.x - p.downX, p.y - p.downY) > TAP_SLOP) moved = true;
    if (pointers.size === 1) {
      panBy(dx, dy);
    } else if (pointers.size === 2) {
      // pinch: scale about the midpoint; only this pointer moved since the
      // last event, so the midpoint shifted by half its delta — pan that
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && dist > 0) {
        zoomTo(zoom * (dist / pinchDist), (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      pinchDist = dist;
      panBy(dx / 2, dy / 2);
    }
  });

  /** @param {PointerEvent} e */
  function up(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size > 0) return;
    canvas.classList.remove("panning");
    if (moved || e.type !== "pointerup") return;
    const now = performance.now();
    const near =
      Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < TAP_SLOP * 2;
    if (now - lastTap.t < TAP_MS && near) {
      lastTap.t = 0;
      toggleFit(e.clientX, e.clientY);
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!enabled) return;
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomTo(zoom * Math.exp(-delta * WHEEL_SENSITIVITY), e.clientX, e.clientY);
    },
    { passive: false },
  );

  return {
    view,
    /** Back to fit without notifying (caller re-renders). */
    reset,
    /** @param {boolean} on disabled during crop mode / while no image */
    setEnabled(on) {
      enabled = on;
      if (!on) reset();
    },
  };
}
