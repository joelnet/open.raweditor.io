// Crop tool: a normalized crop rect (frame UV space — the image after its
// 90° turns) plus the two UIs that edit it — a sidebar CROP section
// (aspect presets, rotate 90° buttons, straighten slider, Crop/Done +
// Reset buttons, export-size readout) and a viewport overlay with a
// draggable rect, rule-of-thirds grid, and eight resize handles, shown
// while crop mode is active. One rect (plus the orientation/straighten
// geometry) drives the preview shader window, the histogram, and the
// full-res export.

import { moveRect, resizeRect, fitAspect } from "./crop-math.js";
import { rotateRectCW, rotateRectCCW } from "../tone/geometry.js";
import { onDoubleTap } from "./double-tap.js";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_CROP_PX = 24; // display px — keeps the box and handles grabbable
const FULL_RECT = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

// Aspect presets: label + w:h pair. null = freeform, "orig" = the image's
// own ratio. Non-square ratios follow the frame orientation on first pick
// (3:2 on a portrait image means 2:3); clicking the active chip again flips
// the orientation.
const PRESETS = /** @type {const} */ ([
  ["FREE", null],
  ["ORIG", "orig"],
  ["1:1", [1, 1]],
  ["3:2", [3, 2]],
  ["4:3", [4, 3]],
  ["16:9", [16, 9]],
]);

const CUSTOM_RATIO_KEY = "raw-editor.crop-custom-ratio";

/**
 * Parse a user-typed ratio like "5:4" (also accepts "5/4", "5x4", "5,4",
 * "5 4", decimals like "1.85:1").
 * @param {string} text
 * @returns {[number, number] | null}
 */
export function parseRatio(text) {
  const m = text
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*[:/x,\s]\s*(\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!(a > 0) || !(b > 0)) return null;
  return [a, b];
}

/** @param {[number, number]} pair */
function ratioLabel(pair) {
  return `${pair[0]}:${pair[1]}`;
}

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
 *           onModeChange: (active: boolean) => void,
 *           onGeometryChange: () => void }} handlers
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
  let orient = 0; // quarter-turns clockwise
  let angle = 0; // straighten, degrees, +CW
  let flipH = false; // mirror the frame horizontally
  let flipV = false; // mirror the frame vertically
  /** @type {import("../tone/tone-math.js").CropRect} */
  let rectOnEnter = { ...FULL_RECT };
  let dispW = 0; // canvas CSS box, cached by reposition()
  let dispH = 0;

  // frame = the oriented image (after the 90° turns)
  const frameW = () => (orient % 2 ? imgH : imgW);
  const frameH = () => (orient % 2 ? imgW : imgH);

  // --- sidebar section ---

  const section = el("div", "section section-crop");
  section.append(el("div", "section-header", "CROP"));
  const body = el("div", "crop-body");
  const chips = el("div", "crop-chips");
  /** @type {HTMLButtonElement[]} */
  const chipButtons = [];
  /** @type {(() => void)[]} restore a chip's label/orientation to its base */
  const chipResets = [];

  /** @param {HTMLButtonElement} chip */
  function activateChip(chip) {
    for (const c of chipButtons) {
      c.classList.toggle("active", c === chip);
      if (c.hasAttribute("aria-pressed"))
        c.setAttribute("aria-pressed", String(c === chip));
    }
  }

  /** Lock the aspect to `pair` and refit the rect.
   * @param {HTMLButtonElement} chip @param {[number, number]} pair */
  function applyPair(chip, pair) {
    activateChip(chip);
    enterMode();
    aspect = pair[0] / pair[1];
    setRectPx(fitAspect(rectPx(), aspect, dispW, dispH));
  }

  /**
   * @param {(typeof PRESETS)[number][0]} label
   * @param {(typeof PRESETS)[number][1]} base
   */
  function addChip(label, base) {
    const chip = /** @type {HTMLButtonElement} */ (el("button", "chip", label));
    chip.type = "button";
    chip.disabled = true;
    chip.setAttribute("aria-pressed", String(base === null));
    if (base === null) chip.classList.add("active");
    /** @type {[number, number] | null} currently applied orientation */
    let pair = null;
    chip.addEventListener("click", () => {
      if (!enabled || imgW === 0) return;
      if (base === null) {
        activateChip(chip);
        aspect = null;
        enterMode();
        return;
      }
      if (chip.classList.contains("active") && pair) {
        pair = [pair[1], pair[0]]; // re-click flips orientation
      } else if (base === "orig") {
        pair = [frameW(), frameH()];
      } else {
        // landscape presets follow the frame orientation on first pick
        pair = frameH() > frameW() ? [base[1], base[0]] : [base[0], base[1]];
      }
      if (base !== "orig") chip.textContent = ratioLabel(pair);
      applyPair(chip, pair);
    });
    chipResets.push(() => {
      pair = null;
      chip.textContent = label;
    });
    chipButtons.push(chip);
    chips.append(chip);
    return chip;
  }

  const freeChip = addChip(PRESETS[0][0], PRESETS[0][1]);
  for (const [label, base] of PRESETS.slice(1)) addChip(label, base);

  // --- custom ratio: a "?:?" chip opens an inline editor; the entered
  // ratio (kept in localStorage) shows as its own chip beside it ---

  /** @type {[number, number] | null} the saved custom ratio */
  let customPair = parseRatio(localStorage.getItem(CUSTOM_RATIO_KEY) ?? "");
  /** @type {[number, number] | null} currently applied orientation */
  let customCurrent = null;
  const customChip = /** @type {HTMLButtonElement} */ (
    el("button", "chip", customPair ? ratioLabel(customPair) : "")
  );
  customChip.type = "button";
  customChip.disabled = true;
  customChip.hidden = !customPair;
  customChip.setAttribute("aria-pressed", "false");
  const editChip = /** @type {HTMLButtonElement} */ (
    el("button", "chip", "?:?")
  );
  editChip.type = "button";
  editChip.disabled = true;
  editChip.title = "Set a custom ratio";

  function openCustomEditor() {
    if (!enabled || editChip.hidden) return; // hidden = already editing
    const input = /** @type {HTMLInputElement} */ (
      el("input", "chip chip-input")
    );
    input.type = "text";
    input.placeholder = "W:H";
    input.value = customPair ? ratioLabel(customPair) : "";
    editChip.hidden = true;
    editChip.after(input);
    let closed = false;
    const close = () => {
      if (closed) return; // input.remove() re-enters via its blur handler
      closed = true;
      input.remove();
      editChip.hidden = false;
    };
    input.addEventListener("keydown", (e) => {
      // keep Enter/Escape from committing/cancelling crop mode (onKey)
      e.stopPropagation();
      if (e.key === "Escape") {
        close();
      } else if (e.key === "Enter") {
        const pair = parseRatio(input.value);
        if (!pair) {
          input.classList.add("invalid");
          input.select();
          return;
        }
        customPair = pair;
        localStorage.setItem(CUSTOM_RATIO_KEY, ratioLabel(pair));
        customChip.textContent = ratioLabel(pair);
        customChip.hidden = false;
        close();
        if (enabled && imgW !== 0) {
          customCurrent = [pair[0], pair[1]];
          applyPair(customChip, customCurrent);
        }
      }
    });
    input.addEventListener("input", () => input.classList.remove("invalid"));
    input.addEventListener("blur", close);
    input.focus();
    input.select();
  }

  customChip.addEventListener("click", () => {
    if (!enabled || imgW === 0 || !customPair) return;
    customCurrent =
      customChip.classList.contains("active") && customCurrent
        ? [customCurrent[1], customCurrent[0]] // re-click flips orientation
        : [customPair[0], customPair[1]];
    customChip.textContent = ratioLabel(customCurrent);
    applyPair(customChip, customCurrent);
  });
  editChip.addEventListener("click", openCustomEditor);
  chipResets.push(() => {
    customCurrent = null;
    if (customPair) customChip.textContent = ratioLabel(customPair);
  });
  chipButtons.push(customChip, editChip);
  chips.append(customChip, editChip);
  // --- rotate 90° + straighten ---

  const rotateRow = el("div", "crop-actions crop-rotate");
  const rotCcwBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "⟲ 90°")
  );
  const rotCwBtn = /** @type {HTMLButtonElement} */ (el("button", "", "90° ⟳"));
  rotCcwBtn.type = "button";
  rotCwBtn.type = "button";
  rotCcwBtn.title = "Rotate counter-clockwise";
  rotCwBtn.title = "Rotate clockwise";
  rotCcwBtn.disabled = true;
  rotCwBtn.disabled = true;
  rotateRow.append(rotCcwBtn, rotCwBtn);

  // Flip mirrors the image content beneath the crop and masks (which stay
  // put in frame space — the crop + local adjustments hold and only the
  // photo mirrors). It only changes frame→source sampling, so no rect
  // or mask anchor moves here; geometry() carries the flags onward.
  const flipRow = el("div", "crop-actions crop-flip");
  const flipHBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "⇋ Flip H")
  );
  const flipVBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "⇅ Flip V")
  );
  flipHBtn.type = "button";
  flipVBtn.type = "button";
  flipHBtn.title = "Flip horizontal";
  flipVBtn.title = "Flip vertical";
  flipHBtn.setAttribute("aria-label", "flip horizontal");
  flipVBtn.setAttribute("aria-label", "flip vertical");
  flipHBtn.setAttribute("aria-pressed", "false");
  flipVBtn.setAttribute("aria-pressed", "false");
  flipHBtn.disabled = true;
  flipVBtn.disabled = true;
  flipRow.append(flipHBtn, flipVBtn);

  function syncFlipUi() {
    flipHBtn.classList.toggle("active", flipH);
    flipVBtn.classList.toggle("active", flipV);
    flipHBtn.setAttribute("aria-pressed", String(flipH));
    flipVBtn.setAttribute("aria-pressed", String(flipV));
  }

  flipHBtn.addEventListener("click", () => {
    if (!enabled || imgW === 0) return;
    flipH = !flipH;
    syncFlipUi();
    handlers.onGeometryChange();
  });
  flipVBtn.addEventListener("click", () => {
    if (!enabled || imgW === 0) return;
    flipV = !flipV;
    syncFlipUi();
    handlers.onGeometryChange();
  });

  const angleRow = el("div", "slider-row crop-angle");
  const angleLabel = el("span", "slider-label", "STRAIGHTEN");
  const angleValue = el("span", "slider-value", "0.0°");
  const angleInput = /** @type {HTMLInputElement} */ (el("input"));
  angleInput.type = "range";
  angleInput.min = "-45";
  angleInput.max = "45";
  angleInput.step = "0.1";
  angleInput.value = "0";
  angleInput.disabled = true;
  angleInput.setAttribute("aria-label", "straighten angle");
  angleRow.append(angleLabel, angleValue, angleInput);

  function syncAngleUi() {
    if (Math.abs(angleInput.valueAsNumber - angle) > 1e-9) {
      angleInput.value = String(angle);
    }
    angleValue.textContent = `${angle > 0 ? "+" : ""}${angle.toFixed(1)}°`;
    angleValue.classList.toggle("pos", angle > 0);
    angleValue.classList.toggle("neg", angle < 0);
  }

  angleInput.addEventListener("input", () => {
    if (!enabled) return;
    angle = angleInput.valueAsNumber;
    syncAngleUi();
    handlers.onGeometryChange();
  });
  // double-tap the label/value to snap back to level
  onDoubleTap(angleRow, () => {
    if (!enabled || angle === 0) return;
    angle = 0;
    syncAngleUi();
    handlers.onGeometryChange();
  });

  /** @param {1 | -1} dir quarter-turns clockwise */
  function rotate90(dir) {
    if (!enabled || imgW === 0) return;
    orient = (orient + (dir === 1 ? 1 : 3)) % 4;
    rect = dir === 1 ? rotateRectCW(rect) : rotateRectCCW(rect);
    if (aspect) aspect = 1 / aspect;
    updateSize();
    handlers.onGeometryChange();
  }
  rotCwBtn.addEventListener("click", () => rotate90(1));
  rotCcwBtn.addEventListener("click", () => rotate90(-1));

  const actions = el("div", "crop-actions");
  const cropBtn = /** @type {HTMLButtonElement} */ (el("button", "", "Crop"));
  const resetBtn = /** @type {HTMLButtonElement} */ (el("button", "", "Reset"));
  cropBtn.type = "button";
  resetBtn.type = "button";
  cropBtn.disabled = true;
  resetBtn.disabled = true;
  actions.append(cropBtn, resetBtn);
  const sizeLine = el("div", "crop-size");
  body.append(chips, rotateRow, flipRow, angleRow, actions, sizeLine);
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
    const fw = orient % 2 ? fullH : fullW;
    const fh = orient % 2 ? fullW : fullH;
    sizeLine.textContent = fw
      ? `${Math.max(Math.round(rect.w * fw), 1)} × ${Math.max(Math.round(rect.h * fh), 1)} px`
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

  function setChipsToFree() {
    for (const reset of chipResets) reset();
    activateChip(freeChip);
    aspect = null;
  }

  cropBtn.addEventListener("click", () => {
    if (active) exitMode(true);
    else enterMode();
  });

  resetBtn.addEventListener("click", () => {
    rect = { ...FULL_RECT };
    setChipsToFree();
    const geoChanged = orient !== 0 || angle !== 0 || flipH || flipV;
    orient = 0;
    angle = 0;
    flipH = false;
    flipV = false;
    syncAngleUi();
    syncFlipUi();
    updateBox();
    updateSize();
    if (geoChanged) handlers.onGeometryChange();
    else handlers.onRectChange();
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

  /** Reset rect and chips to the full frame and drop out of crop mode,
   * all without callbacks (the caller re-layouts anyway). */
  function reset() {
    rect = { ...FULL_RECT };
    orient = 0;
    angle = 0;
    flipH = false;
    flipV = false;
    syncAngleUi();
    syncFlipUi();
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
  }

  return {
    /** @returns {import("../tone/tone-math.js").CropRect} */
    rect: () => ({ ...rect }),
    /** @returns {import("../tone/geometry.js").Geometry} */
    geometry: () => ({ orient, angle, flipH, flipV }),
    /** @returns {{ width: number, height: number } | null} */
    exportSize() {
      if (!fullW || !fullH) return null;
      const fw = orient % 2 ? fullH : fullW;
      const fh = orient % 2 ? fullW : fullH;
      return {
        width: Math.max(Math.round(rect.w * fw), 1),
        height: Math.max(Math.round(rect.h * fh), 1),
      };
    },
    isActive: () => active,
    reposition,
    reset,
    /**
     * New image opened: remember its dimensions and reset the crop.
     * @param {number} previewW @param {number} previewH
     * @param {number} fullResW @param {number} fullResH
     */
    setImage(previewW, previewH, fullResW, fullResH) {
      imgW = previewW;
      imgH = previewH;
      fullW = fullResW;
      fullH = fullResH;
      reset();
    },
    /** @param {boolean} on */
    setEnabled(on) {
      if (!on) exitMode(true); // e.g. a new decode started mid-edit
      enabled = on;
      cropBtn.disabled = !on;
      resetBtn.disabled = !on;
      rotCwBtn.disabled = !on;
      rotCcwBtn.disabled = !on;
      flipHBtn.disabled = !on;
      flipVBtn.disabled = !on;
      angleInput.disabled = !on;
      for (const c of chipButtons) c.disabled = !on;
    },
  };
}
