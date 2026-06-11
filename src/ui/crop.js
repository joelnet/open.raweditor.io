// Crop tool: a normalized crop rect (image UV space) plus the two UIs that
// edit it — a sidebar CROP section (aspect presets, Crop/Done + Reset
// buttons, export-size readout) and a viewport overlay with a draggable
// rect, rule-of-thirds grid, and eight resize handles, shown while crop
// mode is active. One rect drives the preview shader window, the
// histogram, and the full-res export.

import { moveRect, resizeRect, fitAspect } from "./crop-math.js";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_CROP_PX = 24; // display px — keeps the box and handles grabbable
const FULL_RECT = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

// Aspect presets: label + w/h ratio. null = freeform, "orig" = the image's
// own ratio. Non-square ratios follow the frame orientation (3:2 on a
// portrait image means 2:3).
const PRESETS = /** @type {const} */ ([
  ["FREE", null],
  ["ORIG", "orig"],
  ["1:1", 1],
  ["3:2", 3 / 2],
  ["4:3", 4 / 3],
  ["16:9", 16 / 9],
]);

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {HTMLElement} viewport image pane the overlay attaches to
 * @param {HTMLCanvasElement} canvas preview canvas the overlay tracks
 * @param {HTMLElement} panelContainer sidebar column the section renders into
 * @param {{ onRectChange: () => void,
 *           onModeChange: (active: boolean) => void }} handlers
 */
export function initCrop(viewport, canvas, panelContainer, handlers) {
  /** @type {import("../tone/tone-math.js").CropRect} */
  let rect = { ...FULL_RECT };
  let active = false;
  let enabled = false;
  /** @type {number | null} locked w/h in pixel terms, null = freeform */
  let aspect = null;
  let imgW = 0; // preview px — defines the pixel aspect
  let imgH = 0;
  let fullW = 0; // full-res px — for the export-size readout
  let fullH = 0;
  /** @type {import("../tone/tone-math.js").CropRect} */
  let rectOnEnter = { ...FULL_RECT };
  let dispW = 0; // canvas CSS box, cached by reposition()
  let dispH = 0;

  // --- sidebar section ---

  const section = el("div", "section section-crop");
  section.append(el("div", "section-header", "CROP"));
  const body = el("div", "crop-body");
  const chips = el("div", "crop-chips");
  /** @type {HTMLButtonElement[]} */
  const chipButtons = [];
  for (const [label, value] of PRESETS) {
    const chip = /** @type {HTMLButtonElement} */ (el("button", "chip", label));
    chip.type = "button";
    chip.disabled = true;
    chip.setAttribute("aria-pressed", String(value === null));
    if (value === null) chip.classList.add("active");
    chip.addEventListener("click", () => selectPreset(value, chip));
    chipButtons.push(chip);
    chips.append(chip);
  }
  const actions = el("div", "crop-actions");
  const cropBtn = /** @type {HTMLButtonElement} */ (el("button", "", "Crop"));
  const resetBtn = /** @type {HTMLButtonElement} */ (el("button", "", "Reset"));
  cropBtn.type = "button";
  resetBtn.type = "button";
  cropBtn.disabled = true;
  resetBtn.disabled = true;
  actions.append(cropBtn, resetBtn);
  const sizeLine = el("div", "crop-size");
  body.append(chips, actions, sizeLine);
  section.append(body);
  panelContainer.append(section);

  // --- viewport overlay ---

  const overlay = el("div");
  overlay.id = "crop-overlay";
  overlay.hidden = true;
  const box = el("div", "crop-box");
  for (const h of HANDLES) {
    const handle = el("div", `crop-handle ${h}`);
    handle.dataset.handle = h;
    box.append(handle);
  }
  overlay.append(box);
  viewport.append(overlay);

  function updateBox() {
    box.style.left = `${rect.x * dispW}px`;
    box.style.top = `${rect.y * dispH}px`;
    box.style.width = `${rect.w * dispW}px`;
    box.style.height = `${rect.h * dispH}px`;
  }

  function updateSize() {
    sizeLine.textContent = fullW
      ? `${Math.max(Math.round(rect.w * fullW), 1)} × ${Math.max(Math.round(rect.h * fullH), 1)} px`
      : "";
  }

  /** Snap the overlay to the canvas's current box (call after layout). */
  function reposition() {
    if (!active) return;
    dispW = canvas.offsetWidth;
    dispH = canvas.offsetHeight;
    overlay.style.left = `${canvas.offsetLeft}px`;
    overlay.style.top = `${canvas.offsetTop}px`;
    overlay.style.width = `${dispW}px`;
    overlay.style.height = `${dispH}px`;
    updateBox();
  }

  /** @returns {import("./crop-math.js").Rect} crop rect in display px */
  function rectPx() {
    return {
      x: rect.x * dispW,
      y: rect.y * dispH,
      w: rect.w * dispW,
      h: rect.h * dispH,
    };
  }

  /** @param {import("./crop-math.js").Rect} px */
  function setRectPx(px) {
    if (dispW === 0 || dispH === 0) return;
    rect = {
      x: px.x / dispW,
      y: px.y / dispH,
      w: px.w / dispW,
      h: px.h / dispH,
    };
    updateBox();
    updateSize();
    handlers.onRectChange();
  }

  // --- crop mode ---

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      exitMode(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      exitMode(true);
    }
  }

  function enterMode() {
    if (active || !enabled) return;
    active = true;
    rectOnEnter = { ...rect };
    overlay.hidden = false;
    cropBtn.textContent = "Done";
    cropBtn.classList.add("active");
    document.addEventListener("keydown", onKey);
    handlers.onModeChange(true); // main re-layouts to the full frame
  }

  /** @param {boolean} commit false restores the rect from before entering */
  function exitMode(commit) {
    if (!active) return;
    if (!commit) rect = { ...rectOnEnter };
    active = false;
    drag = null;
    overlay.hidden = true;
    box.classList.remove("dragging");
    cropBtn.textContent = "Crop";
    cropBtn.classList.remove("active");
    document.removeEventListener("keydown", onKey);
    updateSize();
    handlers.onModeChange(false);
  }

  /**
   * @param {(typeof PRESETS)[number][1]} value
   * @param {HTMLButtonElement} chip
   */
  function selectPreset(value, chip) {
    if (!enabled || imgW === 0) return;
    for (const c of chipButtons) {
      c.classList.toggle("active", c === chip);
      c.setAttribute("aria-pressed", String(c === chip));
    }
    enterMode(); // picking a ratio means "start cropping"
    if (value === null) {
      aspect = null;
      return;
    }
    let ratio = value === "orig" ? imgW / imgH : value;
    if (value !== "orig" && imgH > imgW && ratio !== 1) ratio = 1 / ratio;
    aspect = ratio;
    setRectPx(fitAspect(rectPx(), ratio, dispW, dispH));
  }

  function setChipsToFree() {
    for (const c of chipButtons) {
      const isFree = c.textContent === "FREE";
      c.classList.toggle("active", isFree);
      c.setAttribute("aria-pressed", String(isFree));
    }
    aspect = null;
  }

  cropBtn.addEventListener("click", () => {
    if (active) exitMode(true);
    else enterMode();
  });

  resetBtn.addEventListener("click", () => {
    rect = { ...FULL_RECT };
    setChipsToFree();
    updateBox();
    updateSize();
    handlers.onRectChange();
  });

  // double-click inside the rect commits, like the Done button
  box.addEventListener("dblclick", () => exitMode(true));

  // --- overlay dragging (move the box, or resize via a handle) ---

  /** @type {{ id: number, handle: string | null,
   *           start: import("./crop-math.js").Rect,
   *           x0: number, y0: number } | null} */
  let drag = null;

  overlay.addEventListener("pointerdown", (e) => {
    if (!active || drag) return;
    const target = /** @type {HTMLElement} */ (e.target);
    const handle = target.dataset.handle ?? null;
    if (!handle && target !== box) return; // shaded area: ignore
    e.preventDefault();
    try {
      overlay.setPointerCapture(e.pointerId);
    } catch {
      // non-capturable pointer (synthetic events); drag still works
    }
    drag = {
      id: e.pointerId,
      handle,
      start: rectPx(),
      x0: e.clientX,
      y0: e.clientY,
    };
    box.classList.add("dragging");
  });

  overlay.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    const next = drag.handle
      ? resizeRect(
          drag.start,
          drag.handle,
          dx,
          dy,
          dispW,
          dispH,
          aspect,
          MIN_CROP_PX,
        )
      : moveRect(drag.start, dx, dy, dispW, dispH);
    setRectPx(next);
  });

  const endDrag = () => {
    drag = null;
    box.classList.remove("dragging");
  };
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);

  return {
    /** @returns {import("../tone/tone-math.js").CropRect} */
    rect: () => ({ ...rect }),
    isActive: () => active,
    reposition,
    /**
     * New image opened: remember its dimensions, reset the crop, and drop
     * out of crop mode without callbacks (the caller re-layouts anyway).
     * @param {number} previewW @param {number} previewH
     * @param {number} fullResW @param {number} fullResH
     */
    setImage(previewW, previewH, fullResW, fullResH) {
      imgW = previewW;
      imgH = previewH;
      fullW = fullResW;
      fullH = fullResH;
      rect = { ...FULL_RECT };
      if (active) {
        active = false;
        drag = null;
        overlay.hidden = true;
        cropBtn.textContent = "Crop";
        cropBtn.classList.remove("active");
        document.removeEventListener("keydown", onKey);
      }
      setChipsToFree();
      updateSize();
    },
    /** @param {boolean} on */
    setEnabled(on) {
      if (!on) exitMode(true); // e.g. a new decode started mid-edit
      enabled = on;
      cropBtn.disabled = !on;
      resetBtn.disabled = !on;
      for (const c of chipButtons) c.disabled = !on;
    },
  };
}
