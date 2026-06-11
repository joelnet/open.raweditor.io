// Local adjustment masks (Lightroom-style linear/radial gradients): a
// MASKS sidebar section that owns the `masks` array in the store, plus a
// viewport SVG overlay for editing the selected mask's geometry — drag the
// pin to move, the axis handles to resize (radial) or the boundary lines
// to widen the falloff (linear), and the lollipop handle to rotate.

import { MASK } from "../tone/constants.js";
import {
  createLinearMask,
  createRadialMask,
  effectiveMasks,
} from "../tone/mask-math.js";
import { EYE_OPEN, EYE_CLOSED } from "./panel.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const ROTATE_ARM = 26; // display px between shape and rotate handle
const MIN_RANGE = 0.005; // linear falloff half-width floor (diagonal frac)
const MIN_RADIUS = 0.02; // radial semi-axis floor (min-dimension frac)

/**
 * Sliders for the selected mask's adjustments — same scales as the global
 * sliders so local edits feel identical.
 * @type {readonly { key: keyof import("../tone/mask-math.js").MaskAdjustments,
 *                   label: string, min: number, max: number, step: number,
 *                   scale: number, decimals: number }[]}
 */
const ADJ_SLIDERS = [
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

  /** @param {readonly import("../tone/mask-math.js").Mask[]} next */
  function commit(next) {
    store.set({ masks: next });
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
  addLinearBtn.type = "button";
  addRadialBtn.type = "button";
  addRow.append(addLinearBtn, addRadialBtn);

  const list = el("div", "mask-list");
  const detail = el("div", "mask-detail");
  section.append(header, addRow, list, detail);
  panelContainer.append(section);

  /** @param {"linear" | "radial"} type */
  function addMask(type) {
    if (!enabled || masks.length >= MASK.MAX) return;
    // create at the center of the current view so it's visible when zoomed
    const v = handlers.getView();
    const cx = v.x + v.w / 2;
    const cy = v.y + v.h / 2;
    const mask =
      type === "linear" ? createLinearMask(cx, cy) : createRadialMask(cx, cy);
    selected = masks.length;
    commit([...masks, mask]);
  }
  addLinearBtn.addEventListener("click", () => addMask("linear"));
  addRadialBtn.addEventListener("click", () => addMask("radial"));

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
    row.addEventListener("dblclick", () => write(reset));
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
  detail.append(tools, featherRow);
  for (const def of ADJ_SLIDERS) {
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

  // --- viewport overlay: geometry editing ---

  const overlay = el("div", "");
  overlay.id = "mask-overlay";
  overlay.hidden = true;
  const svg = /** @type {SVGSVGElement} */ (
    /** @type {unknown} */ (svgEl("svg", {}))
  );
  overlay.append(svg);
  viewport.append(overlay);

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

  function overlayVisible() {
    return enabled && !cropActive && selected >= 0 && selected < masks.length;
  }

  function drawOverlay() {
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
      // allow off-frame anchors (Lightroom does) but keep them grabbable
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

  // --- sidebar sync ---

  function syncUi() {
    addLinearBtn.disabled = !enabled || bypassed || masks.length >= MASK.MAX;
    addRadialBtn.disabled = addLinearBtn.disabled;

    list.textContent = "";
    let linearN = 0;
    let radialN = 0;
    masks.forEach((m, i) => {
      const name =
        m.type === "linear" ? `LINEAR ${++linearN}` : `RADIAL ${++radialN}`;
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
    featherRow.hidden = sel.type !== "radial";
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
    /** Mask index the preview should tint red, or -1. */
    overlayIndex() {
      return showMask && overlayVisible() ? selected : -1;
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
