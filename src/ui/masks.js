// Local adjustment masks (linear/radial gradients): a
// MASKS sidebar section that owns the `masks` array in the store, plus a
// viewport SVG overlay for editing the selected mask's geometry — drag the
// pin to move, the axis handles to resize (radial) or the boundary lines
// to widen the falloff (linear), and the lollipop handle to rotate.

import { MASK } from "../tone/constants.js";
import {
  createLinearMask,
  createRadialMask,
  createBrushMask,
  brushCoverageDims,
  stampBrush,
  effectiveMasks,
} from "../tone/mask-math.js";
import { EYE_OPEN, EYE_CLOSED } from "./panel.js";
import { onDoubleTap } from "./double-tap.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const ROTATE_ARM = 26; // display px between shape and rotate handle
const MIN_RANGE = 0.005; // linear falloff half-width floor (diagonal frac)
const MIN_RADIUS = 0.02; // radial semi-axis floor (min-dimension frac)
// Brush control ranges. Size is a fraction of the frame's longest edge,
// the same unit stampBrush() / MASK.BRUSH_RADIUS use.
const BRUSH_SIZE_MIN = 0.01;
const BRUSH_SIZE_MAX = 0.4;

/**
 * Sliders for the selected mask's adjustments — same scales as the global
 * sliders so local edits feel identical.
 * @type {readonly (readonly {
 *   key: keyof import("../tone/mask-math.js").MaskAdjustments,
 *   label: string, min: number, max: number, step: number,
 *   scale: number, decimals: number, signed?: boolean
 * }[])[]}
 */
const ADJ_SLIDER_GROUPS = [
  [
    {
      key: "temp",
      label: "TEMP",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
    {
      key: "tint",
      label: "TINT",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
  ],
  [
    {
      key: "exposure",
      label: "EXPOSURE",
      min: -5,
      max: 5,
      step: 0.05,
      scale: 1,
      decimals: 2,
    },
    {
      key: "contrast",
      label: "CONTRAST",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
    {
      key: "lightBalance",
      label: "LIGHT BALANCE",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
    {
      key: "highlights",
      label: "HIGHLIGHTS",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
    {
      key: "shadows",
      label: "SHADOWS",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
    {
      key: "whites",
      label: "WHITES",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
    {
      key: "blacks",
      label: "BLACKS",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
  ],
  [
    {
      key: "sharpening",
      label: "SHARPEN",
      min: 0,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
      signed: false,
    },
    {
      key: "texture",
      label: "TEXTURE",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
    {
      key: "clarity",
      label: "CLARITY",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
    {
      key: "dehaze",
      label: "DEHAZE",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
  ],
  [
    {
      key: "vibrance",
      label: "VIBRANCE",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
    {
      key: "saturation",
      label: "SATURATION",
      min: -100,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
    },
  ],
];

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
 * @param {string} tag
 * @param {Record<string, string>} attrs
 */
function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * @param {HTMLElement} viewport image pane the overlay attaches to
 * @param {HTMLCanvasElement} canvas preview canvas the overlay tracks
 * @param {HTMLElement} panelContainer sidebar column the section renders into
 * @param {import("../state.js").Store} store
 * @param {{ getView: () => import("../gl/renderer.js").ViewRect,
 *           onUiChange: () => void }} handlers selection/overlay changes that
 *   need a re-render but don't touch the store
 */
export function initMasks(viewport, canvas, panelContainer, store, handlers) {
  /** @type {readonly import("../tone/mask-math.js").Mask[]} */
  let masks = [];
  let selected = -1;
  let showMask = false;
  let bypassed = false;
  let enabled = false;
  let cropActive = false;
  let imgW = 0; // preview px — defines pixel-space mask geometry
  let imgH = 0;
  let dispW = 0; // canvas CSS box, cached by reposition()
  let dispH = 0;

  // Brush tool state (the active drawing settings, not per-mask): radius as
  // a fraction of the longest frame edge, hardness/flow in [0, 1], plus the
  // add/erase toggle. One shared brush. Painting
  // is always live while a brush mask is selected — there's no paint toggle.
  let brushSize = MASK.BRUSH_RADIUS;
  let brushHardness = MASK.BRUSH_HARDNESS;
  let brushFlow = MASK.BRUSH_FLOW;
  let brushErase = false;

  /** @param {readonly import("../tone/mask-math.js").Mask[]} next */
  function commit(next) {
    store.set({ masks: next });
  }

  /**
   * Coverage of a brush mask was painted in place: bump its version and
   * commit a shallow-copied mask so the store notifies (renderer re-uploads
   * the one changed layer, export sees the live raster). The Uint8Array
   * reference is kept stable — we mutate it, never reallocate per stroke, so
   * a drag stays allocation-free (side-buffer-style efficiency while the
   * raster still lives on the store mask for free structured-clone export).
   * @param {number} index
   */
  function commitCoverage(index) {
    commit(
      masks.map((m, i) =>
        i === index
          ? { ...m, coverageVersion: (m.coverageVersion ?? 0) + 1 }
          : m,
      ),
    );
  }

  /** @param {Partial<import("../tone/mask-math.js").Mask>} patch */
  function patchSelected(patch) {
    if (selected < 0 || selected >= masks.length) return;
    commit(masks.map((m, i) => (i === selected ? { ...m, ...patch } : m)));
  }

  // --- sidebar section ---

  const section = el("div", "section section-masks");
  const header = el("div", "section-header", "MASKS");
  const eye = /** @type {HTMLButtonElement} */ (el("button", "section-eye"));
  eye.type = "button";
  eye.disabled = true;
  eye.innerHTML = EYE_OPEN;
  eye.setAttribute("aria-label", "Toggle masks edits");
  eye.setAttribute("aria-pressed", "true");
  eye.addEventListener("click", () => {
    bypassed = !bypassed;
    section.classList.toggle("bypassed", bypassed);
    eye.innerHTML = bypassed ? EYE_CLOSED : EYE_OPEN;
    eye.setAttribute("aria-pressed", String(!bypassed));
    syncUi();
    handlers.onUiChange();
  });
  header.append(eye);

  const addRow = el("div", "mask-add-row");
  const addLinearBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "+ Linear")
  );
  const addRadialBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "+ Radial")
  );
  const addBrushBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "+ Brush")
  );
  addLinearBtn.type = "button";
  addRadialBtn.type = "button";
  addBrushBtn.type = "button";
  addRow.append(addLinearBtn, addRadialBtn, addBrushBtn);

  const list = el("div", "mask-list");
  const detail = el("div", "mask-detail");
  section.append(header, addRow, list, detail);
  panelContainer.append(section);

  /** @param {"linear" | "radial" | "brush"} type */
  function addMask(type) {
    if (!enabled || masks.length >= MASK.MAX) return;
    // create at the center of the current view so it's visible when zoomed
    const v = handlers.getView();
    const cx = v.x + v.w / 2;
    const cy = v.y + v.h / 2;
    /** @type {import("../tone/mask-math.js").Mask} */
    let mask;
    if (type === "brush") {
      const dims = brushCoverageDims(imgW, imgH);
      mask = createBrushMask(dims.w, dims.h);
      // a brush has no analytic geometry to drag — you paint it on the
      // canvas. Turn the red coverage overlay on so strokes are visible as
      // they're laid down (the mask shows while you brush).
      showMask = true;
    } else {
      mask =
        type === "linear" ? createLinearMask(cx, cy) : createRadialMask(cx, cy);
    }
    selected = masks.length;
    commit([...masks, mask]);
  }
  addLinearBtn.addEventListener("click", () => addMask("linear"));
  addRadialBtn.addEventListener("click", () => addMask("radial"));
  addBrushBtn.addEventListener("click", () => addMask("brush"));

  // --- selected-mask detail: tools + feather + adjustment sliders ---

  const tools = el("div", "mask-tools");
  const invertBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Invert")
  );
  const showBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Show Mask")
  );
  const deleteBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Delete")
  );
  invertBtn.type = "button";
  showBtn.type = "button";
  deleteBtn.type = "button";
  invertBtn.setAttribute("aria-pressed", "false");
  showBtn.setAttribute("aria-pressed", "false");
  invertBtn.addEventListener("click", () => {
    const m = masks[selected];
    if (m) patchSelected({ invert: !m.invert });
  });
  showBtn.addEventListener("click", () => {
    showMask = !showMask;
    showBtn.classList.toggle("active", showMask);
    showBtn.setAttribute("aria-pressed", String(showMask));
    handlers.onUiChange();
  });
  deleteBtn.addEventListener("click", () => {
    if (selected < 0) return;
    const next = masks.filter((_, i) => i !== selected);
    selected = Math.min(selected, next.length - 1);
    commit(next);
  });
  tools.append(invertBtn, showBtn, deleteBtn);

  /** @type {{ row: HTMLElement, input: HTMLInputElement, value: HTMLElement,
   *           read: (m: import("../tone/mask-math.js").Mask) => number,
   *           scale: number, decimals: number, signed: boolean }[]} */
  const sliderRows = [];

  /**
   * @param {{ label: string, min: number, max: number, step: number,
   *           scale: number, decimals: number, signed?: boolean }} def
   * @param {(m: import("../tone/mask-math.js").Mask) => number} read
   * @param {(raw: number) => void} write store-bound, takes the raw value
   * @param {number} [reset]
   */
  function makeRow(def, read, write, reset = 0) {
    const row = el("div", "slider-row");
    const label = el("span", "slider-label", def.label);
    const value = el("span", "slider-value", "0");
    const input = /** @type {HTMLInputElement} */ (el("input"));
    input.type = "range";
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = "0";
    input.setAttribute("aria-label", `mask ${def.label.toLowerCase()}`);
    input.addEventListener("input", () => write(input.valueAsNumber));
    onDoubleTap(row, () => write(reset));
    row.append(label, value, input);
    sliderRows.push({
      row,
      input,
      value,
      read,
      scale: def.scale,
      decimals: def.decimals,
      signed: def.signed ?? true,
    });
    return row;
  }

  const featherRow = makeRow(
    {
      label: "FEATHER",
      min: 0,
      max: 100,
      step: 1,
      scale: 0.01,
      decimals: 0,
      signed: false,
    },
    (m) => m.feather,
    (raw) => patchSelected({ feather: raw * 0.01 }),
    MASK.RADIAL_FEATHER * 100,
  );

  // --- brush tool controls (only shown for brush masks) ---

  /**
   * A non-store-bound tool slider (the brush settings are tool state, not
   * per-mask): label + value readout + range input, value as a percentage.
   * @param {string} label
   * @param {number} min @param {number} max
   * @param {() => number} read 0–100 raw value
   * @param {(raw: number) => void} write
   */
  function makeToolRow(label, min, max, read, write) {
    const row = el("div", "slider-row");
    const lab = el("span", "slider-label", label);
    const value = el("span", "slider-value", "0");
    const input = /** @type {HTMLInputElement} */ (el("input"));
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.setAttribute("aria-label", `brush ${label.toLowerCase()}`);
    const sync = () => {
      const v = Math.round(read());
      input.value = String(v);
      value.textContent = String(v);
    };
    input.addEventListener("input", () => {
      write(input.valueAsNumber);
      value.textContent = String(Math.round(input.valueAsNumber));
    });
    row.append(lab, value, input);
    return { row, sync };
  }

  const brushTools = el("div", "brush-tools");
  const addEraseBtn = /** @type {HTMLButtonElement} */ (
    el("button", "", "Erase")
  );
  const clearBtn = /** @type {HTMLButtonElement} */ (el("button", "", "Clear"));
  addEraseBtn.type = "button";
  clearBtn.type = "button";
  addEraseBtn.setAttribute("aria-pressed", "false");
  addEraseBtn.addEventListener("click", () => {
    brushErase = !brushErase;
    syncBrushUi();
    refreshBrushCursor();
  });
  clearBtn.addEventListener("click", () => {
    const m = masks[selected];
    if (!m || m.type !== "brush" || !m.coverage) return;
    m.coverage.fill(0);
    commitCoverage(selected);
  });
  brushTools.append(addEraseBtn, clearBtn);

  // Size in percent of the longest frame edge; map to the [MIN, MAX] frac.
  const sizeRow = makeToolRow(
    "SIZE",
    Math.round(BRUSH_SIZE_MIN * 100),
    Math.round(BRUSH_SIZE_MAX * 100),
    () => brushSize * 100,
    (raw) => {
      brushSize = raw / 100;
      refreshBrushCursor();
    },
  );
  const hardnessRow = makeToolRow(
    "HARDNESS",
    0,
    100,
    () => brushHardness * 100,
    (raw) => (brushHardness = raw / 100),
  );
  const flowRow = makeToolRow(
    "FLOW",
    1,
    100,
    () => brushFlow * 100,
    (raw) => (brushFlow = raw / 100),
  );
  const brushControls = el("div", "brush-controls");
  brushControls.append(brushTools, sizeRow.row, hardnessRow.row, flowRow.row);

  function syncBrushUi() {
    const m = masks[selected];
    const isBrush = !!m && m.type === "brush";
    brushControls.hidden = !isBrush;
    if (!isBrush) return;
    const off = !enabled || bypassed;
    addEraseBtn.disabled = off;
    clearBtn.disabled = off;
    addEraseBtn.classList.toggle("active", brushErase);
    addEraseBtn.setAttribute("aria-pressed", String(brushErase));
    addEraseBtn.textContent = brushErase ? "Erase" : "Add";
    sizeRow.sync();
    hardnessRow.sync();
    flowRow.sync();
  }

  // a clear separator between the shape/brush tools above (size, hardness,
  // flow, feather) and the adjustment sliders (temp, exposure, …) below
  const adjDivider = el("div", "mask-divider");
  detail.append(tools, brushControls, featherRow, adjDivider);
  for (
    let groupIndex = 0;
    groupIndex < ADJ_SLIDER_GROUPS.length;
    groupIndex++
  ) {
    if (groupIndex > 0) detail.append(el("div", "mask-divider"));
    for (const def of ADJ_SLIDER_GROUPS[groupIndex]) {
      detail.append(
        makeRow(
          def,
          (m) => m.adjustments[def.key],
          (raw) => {
            const m = masks[selected];
            if (!m) return;
            patchSelected({
              adjustments: { ...m.adjustments, [def.key]: raw * def.scale },
            });
          },
        ),
      );
    }
  }

  // --- viewport overlay: geometry editing ---

  const overlay = el("div", "");
  overlay.id = "mask-overlay";
  overlay.hidden = true;
  const svg = /** @type {SVGSVGElement} */ (
    /** @type {unknown} */ (svgEl("svg", {}))
  );
  overlay.append(svg);
  viewport.append(overlay);

  // Painting surface: a transparent capture layer tracking the canvas box
  // exactly like #mask-overlay, live only while a brush mask is selected and
  // paint mode is armed. Separate from the SVG overlay (which is mostly
  // pointer-transparent) so the whole frame grabs strokes.
  const paint = el("div", "");
  paint.id = "paint-overlay";
  paint.hidden = true;
  viewport.append(paint);

  // Brush-size cursor: a ring that tracks the pointer over the paint surface
  // so the brush footprint (and add vs erase, by color) is visible before a
  // stroke lands — the Photoshop-style brush cursor. Pointer-transparent,
  // sized from brushSize in display px. Lives inside #paint-overlay so it
  // sits above the canvas wherever the pointer is.
  const brushCursor = el("div", "brush-cursor");
  brushCursor.hidden = true;
  paint.append(brushCursor);
  let cursorX = 0;
  let cursorY = 0;

  const view = () => handlers.getView();
  /** display px per image px (layout keeps x/y scale uniform) */
  const dispScale = () => (imgW > 0 ? dispW / (view().w * imgW) : 0);
  /** @param {number} u @param {number} v */
  function uvToDisp(u, v) {
    const vw = view();
    return [((u - vw.x) / vw.w) * dispW, ((v - vw.y) / vw.h) * dispH];
  }
  /** @param {number} x @param {number} y */
  function dispToUv(x, y) {
    const vw = view();
    return [vw.x + (x / dispW) * vw.w, vw.y + (y / dispH) * vw.h];
  }

  /** Position + size the brush-size ring at a paint-local point. The radius
   * is brushSize (a fraction of the longest frame edge) converted to display
   * px via dispScale, so it tracks zoom and matches what stampBrush() lays.
   * @param {number} px @param {number} py paint-local px */
  function updateBrushCursor(px, py) {
    cursorX = px;
    cursorY = py;
    const d = 2 * brushSize * Math.max(imgW, imgH) * dispScale();
    brushCursor.style.width = `${d}px`;
    brushCursor.style.height = `${d}px`;
    brushCursor.style.left = `${px}px`;
    brushCursor.style.top = `${py}px`;
  }

  /** Re-apply size/erase styling at the last cursor position — called when
   * the brush settings change while the ring is on screen. */
  function refreshBrushCursor() {
    brushCursor.classList.toggle("erase", brushErase);
    if (!brushCursor.hidden) updateBrushCursor(cursorX, cursorY);
  }

  /** Selected-mask context is active (any mask type). */
  function selectionActive() {
    return enabled && !cropActive && selected >= 0 && selected < masks.length;
  }

  /** The SVG geometry overlay shows for linear/radial only (brush has no
   * parametric handles — it's painted on the canvas). */
  function overlayVisible() {
    const m = masks[selected];
    return selectionActive() && !!m && m.type !== "brush";
  }

  /** The transparent paint surface is live whenever a brush mask is the
   * selected mask (selecting a brush *is* entering paint — no toggle). */
  function paintActive() {
    const m = masks[selected];
    return selectionActive() && !!m && m.type === "brush" && !bypassed;
  }

  function drawOverlay() {
    // brush masks use the paint surface; the analytic SVG overlay is hidden
    paint.hidden = !paintActive();
    if (paint.hidden) brushCursor.hidden = true;
    const visible = overlayVisible();
    overlay.hidden = !visible;
    svg.textContent = "";
    if (!visible || dispW === 0) return;
    const m = masks[selected];
    const [cx, cy] = uvToDisp(m.x, m.y);
    const deg = (m.angle * 180) / Math.PI;
    const s = dispScale();
    const g = svgEl("g", {
      transform: `translate(${cx} ${cy}) rotate(${deg})`,
    });

    if (m.type === "radial") {
      const a = m.radiusX * Math.min(imgW, imgH) * s;
      const b = m.radiusY * Math.min(imgW, imgH) * s;
      g.append(
        svgEl("ellipse", { class: "mask-shape", rx: String(a), ry: String(b) }),
        svgEl("ellipse", {
          class: "mask-shape inner",
          rx: String(a * (1 - m.feather)),
          ry: String(b * (1 - m.feather)),
        }),
        svgEl("line", {
          class: "mask-arm",
          y1: String(-b),
          y2: String(-b - ROTATE_ARM),
        }),
        svgEl("circle", {
          class: "mask-handle",
          cy: String(-b - ROTATE_ARM),
          r: "5",
          "data-handle": "rotate",
        }),
      );
      for (const [hx, hy, handle] of /** @type {const} */ ([
        [a, 0, "rx"],
        [-a, 0, "rx"],
        [0, b, "ry"],
        [0, -b, "ry"],
      ])) {
        g.append(
          svgEl("circle", {
            class: "mask-handle",
            cx: String(hx),
            cy: String(hy),
            r: "5",
            "data-handle": handle,
          }),
        );
      }
    } else {
      // local +x is the gradient direction; boundary lines run along local y
      const off = m.range * Math.hypot(imgW, imgH) * s;
      const len = dispW + dispH; // long enough to cross any view
      for (const [x, cls] of /** @type {const} */ ([
        [0, "mask-shape"],
        [off, "mask-shape inner"],
        [-off, "mask-shape inner"],
      ])) {
        g.append(
          svgEl("line", {
            class: cls,
            x1: String(x),
            x2: String(x),
            y1: String(-len),
            y2: String(len),
          }),
        );
        if (x !== 0) {
          g.append(
            svgEl("line", {
              class: "mask-hit",
              x1: String(x),
              x2: String(x),
              y1: String(-len),
              y2: String(len),
              "data-handle": "range",
            }),
          );
        }
      }
      g.append(
        svgEl("line", { class: "mask-arm", x2: String(ROTATE_ARM * 1.5) }),
        svgEl("circle", {
          class: "mask-handle",
          cx: String(ROTATE_ARM * 1.5),
          r: "5",
          "data-handle": "rotate",
        }),
      );
    }

    g.append(
      svgEl("circle", {
        class: "mask-handle mask-pin",
        r: "6",
        "data-handle": "move",
      }),
    );
    svg.append(g);
  }

  /** Snap the overlay to the canvas's current box (call after layout). */
  function reposition() {
    dispW = canvas.offsetWidth;
    dispH = canvas.offsetHeight;
    overlay.style.left = `${canvas.offsetLeft}px`;
    overlay.style.top = `${canvas.offsetTop}px`;
    overlay.style.width = `${dispW}px`;
    overlay.style.height = `${dispH}px`;
    svg.setAttribute("width", String(dispW));
    svg.setAttribute("height", String(dispH));
    svg.setAttribute("viewBox", `0 0 ${dispW} ${dispH}`);
    // the paint surface tracks the same box
    paint.style.left = `${canvas.offsetLeft}px`;
    paint.style.top = `${canvas.offsetTop}px`;
    paint.style.width = `${dispW}px`;
    paint.style.height = `${dispH}px`;
    drawOverlay();
  }

  // --- overlay dragging ---

  /** @type {{ id: number, handle: string, grabX: number, grabY: number } | null} */
  let drag = null;

  /** @param {PointerEvent} e @returns {[number, number]} overlay-local px */
  function localPoint(e) {
    const r = overlay.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  overlay.addEventListener("pointerdown", (e) => {
    if (drag || !overlayVisible()) return;
    const handle = /** @type {SVGElement} */ (e.target).dataset?.handle;
    if (!handle) return;
    e.preventDefault();
    const m = masks[selected];
    const [px, py] = localPoint(e);
    const [mx, my] = uvToDisp(m.x, m.y);
    drag = {
      id: e.pointerId,
      handle,
      grabX: px - mx,
      grabY: py - my,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
  });

  /** @param {PointerEvent} e */
  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const m = masks[selected];
    if (!m) return;
    const [px, py] = localPoint(e);
    const [cx, cy] = uvToDisp(m.x, m.y);
    const dx = px - cx;
    const dy = py - cy;
    const s = dispScale();
    if (drag.handle === "move") {
      const [u, v] = dispToUv(px - drag.grabX, py - drag.grabY);
      // allow off-frame anchors but keep them grabbable
      patchSelected({
        x: Math.min(Math.max(u, -0.5), 1.5),
        y: Math.min(Math.max(v, -0.5), 1.5),
      });
    } else if (drag.handle === "rotate") {
      // the handle sits on local +x for linear, local -y for radial
      const angle =
        m.type === "linear"
          ? Math.atan2(dy, dx)
          : Math.atan2(dy, dx) + Math.PI / 2;
      patchSelected({ angle });
    } else if (drag.handle === "range") {
      const t = Math.abs(dx * Math.cos(m.angle) + dy * Math.sin(m.angle));
      patchSelected({
        range: Math.max(t / s / Math.hypot(imgW, imgH), MIN_RANGE),
      });
    } else if (drag.handle === "rx" || drag.handle === "ry") {
      const along =
        drag.handle === "rx"
          ? dx * Math.cos(m.angle) + dy * Math.sin(m.angle)
          : -dx * Math.sin(m.angle) + dy * Math.cos(m.angle);
      const r = Math.max(
        Math.abs(along) / s / Math.min(imgW, imgH),
        MIN_RADIUS,
      );
      patchSelected(drag.handle === "rx" ? { radiusX: r } : { radiusY: r });
    }
  }

  /** @param {PointerEvent} e */
  function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
  }

  // --- brush painting ---

  /** Active stroke: pointer id, last UV stamped, and whether the coverage
   * grew since the last frame commit. */
  /** @type {{ id: number, lastU: number, lastV: number } | null} */
  let stroke = null;
  let strokeDirty = false; // coverage changed but not yet committed
  let strokeRaf = 0;

  /** @param {MouseEvent} e @returns {[number, number]} paint-local px
   * (MouseEvent base covers both PointerEvent strokes and WheelEvent resize) */
  function paintPoint(e) {
    const r = paint.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Stamp one dab at frame UV (u, v) into the selected brush coverage. */
  function stampAt(/** @type {number} */ u, /** @type {number} */ v) {
    const m = masks[selected];
    if (!m || m.type !== "brush" || !m.coverage || !m.coverageW || !m.coverageH)
      return;
    stampBrush(
      m.coverage,
      m.coverageW,
      m.coverageH,
      u,
      v,
      brushSize,
      brushHardness,
      brushFlow,
      brushErase,
      imgH > 0 ? imgW / imgH : 1,
    );
    strokeDirty = true;
  }

  /** Coalesce coverage uploads to one per animation frame during a drag —
   * the whole point of the version-counter scheme. */
  function scheduleStrokeCommit() {
    if (strokeRaf) return;
    strokeRaf = requestAnimationFrame(() => {
      strokeRaf = 0;
      if (strokeDirty && selected >= 0) {
        strokeDirty = false;
        commitCoverage(selected);
      }
    });
  }

  paint.addEventListener("pointerdown", (e) => {
    if (stroke || !paintActive()) return;
    e.preventDefault();
    paint.setPointerCapture(e.pointerId);
    const [px, py] = paintPoint(e);
    brushCursor.hidden = false;
    updateBrushCursor(px, py);
    const [u, v] = dispToUv(px, py);
    stroke = { id: e.pointerId, lastU: u, lastV: v };
    stampAt(u, v);
    scheduleStrokeCommit();
  });

  // Keep the size ring under the pointer whenever it's over the paint surface
  // (which is only live for a selected brush), whether or not a stroke is in
  // progress.
  paint.addEventListener("pointerenter", (e) => {
    const [px, py] = paintPoint(e);
    brushCursor.hidden = false;
    updateBrushCursor(px, py);
  });
  paint.addEventListener("pointerleave", () => {
    if (!stroke) brushCursor.hidden = true;
  });

  paint.addEventListener("pointermove", (e) => {
    const [px, py] = paintPoint(e);
    brushCursor.hidden = false;
    updateBrushCursor(px, py);
    if (!stroke || e.pointerId !== stroke.id) return;
    e.preventDefault();
    const [u, v] = dispToUv(px, py);
    // Interpolate from the last sample so a fast drag lays a continuous
    // line, not gapped dabs. Step ≈ a quarter of the brush radius, measured
    // in longest-frame-edge units (the unit brushSize uses): u spans the
    // width, v the height, so scale the shorter axis by aspect.
    const du = u - stroke.lastU;
    const dv = v - stroke.lastV;
    const aspect = imgH > 0 ? imgW / imgH : 1;
    const distLong =
      aspect >= 1
        ? Math.hypot(du, dv / aspect) // wide: longest edge = width
        : Math.hypot(du * aspect, dv); // tall: longest edge = height
    const step = Math.max(brushSize * 0.25, 1e-4);
    const n = Math.max(1, Math.ceil(distLong / step));
    for (let i = 1; i <= n; i++) {
      stampAt(stroke.lastU + (du * i) / n, stroke.lastV + (dv * i) / n);
    }
    stroke.lastU = u;
    stroke.lastV = v;
    scheduleStrokeCommit();
  });

  /** @param {PointerEvent} e */
  function endStroke(e) {
    if (!stroke || e.pointerId !== stroke.id) return;
    if (paint.hasPointerCapture(e.pointerId))
      paint.releasePointerCapture(e.pointerId);
    stroke = null;
    if (strokeRaf) {
      cancelAnimationFrame(strokeRaf);
      strokeRaf = 0;
    }
    // final commit so the last dabs land even if no frame fired
    if (strokeDirty && selected >= 0) {
      strokeDirty = false;
      commitCoverage(selected);
    }
  }
  paint.addEventListener("pointerup", endStroke);
  paint.addEventListener("pointercancel", endStroke);

  // Wheel over the paint surface resizes the brush (like the SIZE slider).
  // The paint overlay sits above the canvas as a sibling, so the canvas's
  // zoom-wheel handler never sees this event — no conflict. Step grows with
  // the current size (~15% per notch, min 1) so it feels right across the
  // whole range.
  paint.addEventListener(
    "wheel",
    (e) => {
      if (!paintActive()) return;
      e.preventDefault();
      const units = Math.round(brushSize * 100);
      const step = Math.max(1, Math.round(units * 0.15));
      const min = Math.round(BRUSH_SIZE_MIN * 100);
      const max = Math.round(BRUSH_SIZE_MAX * 100);
      const dir = e.deltaY < 0 ? 1 : -1;
      brushSize = Math.min(Math.max(units + dir * step, min), max) / 100;
      sizeRow.sync();
      const [px, py] = paintPoint(e);
      brushCursor.hidden = false;
      updateBrushCursor(px, py);
    },
    { passive: false },
  );

  // --- sidebar sync ---

  function syncUi() {
    addLinearBtn.disabled = !enabled || bypassed || masks.length >= MASK.MAX;
    addRadialBtn.disabled = addLinearBtn.disabled;
    addBrushBtn.disabled = addLinearBtn.disabled;

    list.textContent = "";
    let linearN = 0;
    let radialN = 0;
    let brushN = 0;
    masks.forEach((m, i) => {
      const name =
        m.type === "linear"
          ? `LINEAR ${++linearN}`
          : m.type === "radial"
            ? `RADIAL ${++radialN}`
            : `BRUSH ${++brushN}`;
      const item = el("div", "mask-item");
      item.classList.toggle("active", i === selected);
      const selectBtn = /** @type {HTMLButtonElement} */ (
        el("button", "mask-name", name)
      );
      selectBtn.type = "button";
      selectBtn.disabled = !enabled || bypassed;
      selectBtn.addEventListener("click", () => {
        selected = selected === i ? -1 : i;
        syncUi();
        drawOverlay();
        handlers.onUiChange();
      });
      const itemEye = /** @type {HTMLButtonElement} */ (
        el("button", "mask-item-eye")
      );
      itemEye.type = "button";
      itemEye.disabled = !enabled || bypassed;
      itemEye.innerHTML = m.enabled ? EYE_OPEN : EYE_CLOSED;
      itemEye.setAttribute("aria-label", `Toggle ${name.toLowerCase()}`);
      itemEye.setAttribute("aria-pressed", String(m.enabled));
      itemEye.addEventListener("click", () => {
        commit(
          masks.map((mk, j) =>
            j === i ? { ...mk, enabled: !mk.enabled } : mk,
          ),
        );
      });
      item.append(selectBtn, itemEye);
      list.append(item);
    });

    const sel = selected >= 0 ? masks[selected] : null;
    detail.hidden = !sel;
    if (!sel) return;
    const controlsOff = !enabled || bypassed;
    invertBtn.disabled = controlsOff;
    showBtn.disabled = controlsOff;
    deleteBtn.disabled = controlsOff;
    invertBtn.classList.toggle("active", sel.invert);
    invertBtn.setAttribute("aria-pressed", String(sel.invert));
    showBtn.classList.toggle("active", showMask);
    showBtn.setAttribute("aria-pressed", String(showMask));
    featherRow.hidden = sel.type !== "radial";
    syncBrushUi();
    for (const r of sliderRows) {
      const scaled = r.read(sel);
      const raw = scaled / r.scale;
      if (Math.abs(r.input.valueAsNumber - raw) > 1e-9) {
        r.input.value = String(raw);
      }
      r.input.disabled = controlsOff;
      r.value.textContent =
        (r.signed && raw > 0 ? "+" : "") +
        raw.toFixed(r.decimals).replace(/^-0(\.0*)?$/, "0$1");
      r.value.classList.toggle("pos", r.signed && raw > 0);
      r.value.classList.toggle("neg", r.signed && raw < 0);
    }
  }

  store.subscribe((state) => {
    masks = state.masks ?? [];
    if (selected >= masks.length) selected = masks.length - 1;
    syncUi();
    drawOverlay();
  });

  return {
    /**
     * Settings as the pipeline should see them: disabled masks neutralized,
     * everything neutralized while the section eye is closed.
     * @template {{ masks: readonly import("../tone/mask-math.js").Mask[] }} S
     * @param {S} settings
     * @returns {S}
     */
    effective(settings) {
      return effectiveMasks(settings, bypassed);
    },
    /** Mask index the preview should tint red, or -1. The red overlay keys
     * off maskWeight in the shader, so it works for brush masks too. */
    overlayIndex() {
      return showMask && selectionActive() ? selected : -1;
    },
    reposition,
    /** Frame dims changed (90° rotation) — masks keep their frame-UV
     * coordinates, only the pixel-space normalization follows.
     * @param {number} frameW @param {number} frameH */
    setFrameSize(frameW, frameH) {
      imgW = frameW;
      imgH = frameH;
    },
    /** @param {number} previewW @param {number} previewH */
    setImage(previewW, previewH) {
      imgW = previewW;
      imgH = previewH;
      selected = -1;
      showMask = false;
      brushCursor.hidden = true;
      showBtn.classList.remove("active");
      showBtn.setAttribute("aria-pressed", "false");
    },
    /** @param {boolean} on */
    setEnabled(on) {
      enabled = on;
      section.classList.toggle("disabled", !on);
      eye.disabled = !on;
      syncUi();
      drawOverlay();
    },
    /** Crop mode owns the viewport; hide the mask overlay meanwhile.
     * @param {boolean} active */
    setCropActive(active) {
      cropActive = active;
      drawOverlay();
    },
    /** Re-show mask edits (used when a new image is opened or on revert). */
    resetBypass() {
      bypassed = false;
      section.classList.remove("bypassed");
      eye.innerHTML = EYE_OPEN;
      eye.setAttribute("aria-pressed", "true");
    },
  };
}
