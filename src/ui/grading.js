// Lightroom-style color grading UI: a tab strip (3-way / shadows /
// midtones / highlights), hue-saturation color wheels with draggable
// pucks, per-zone luminance sliders, and blending/balance sliders.
// Wheel colors come from the same hueColor() the pipeline tints with, so
// what you pick is what gets applied.

import { GRADE_ZONES, GRADE_SLIDERS } from "../state.js";
import { hueColor } from "../tone/tone-math.js";

/**
 * @typedef {import("../state.js").SliderDef} SliderDef
 * @typedef {import("../state.js").GradeZone} GradeZone
 * @typedef {import("../tone/tone-math.js").ToneSettings} ToneSettings
 */

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
 * Wheel/puck color at a hue (turns) and saturation [0, 1]: white center to
 * pure hue at the rim, slightly dimmed to sit well on the dark panel.
 * @param {number} hue
 * @param {number} sat
 * @returns {[number, number, number]} 0–255 channels
 */
function wheelColor(hue, sat) {
  const [r, g, b] = hueColor(hue);
  const dim = 0.88;
  return [
    Math.round((1 - sat * (1 - r)) * dim * 255),
    Math.round((1 - sat * (1 - g)) * dim * 255),
    Math.round((1 - sat * (1 - b)) * dim * 255),
  ];
}

/** @param {HTMLCanvasElement} canvas @param {number} cssSize */
function drawWheel(canvas, cssSize) {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.round(cssSize * dpr);
  canvas.width = size;
  canvas.height = size;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const img = ctx.createImageData(size, size);
  const c = (size - 1) / 2;
  const R = size / 2 - dpr; // leave a little room for the anti-aliased rim
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const r = Math.hypot(dx, dy);
      const alpha = Math.min(Math.max(R + dpr - r, 0), dpr) / dpr;
      if (alpha === 0) continue;
      const hue = (Math.atan2(-dy, dx) / (2 * Math.PI) + 1) % 1;
      const sat = Math.min(r / R, 1);
      const [cr, cg, cb] = wheelColor(hue, sat);
      const i = (y * size + x) * 4;
      img.data[i] = cr;
      img.data[i + 1] = cg;
      img.data[i + 2] = cb;
      img.data[i + 3] = alpha * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * A draggable hue/sat color wheel bound to one grading zone.
 * @param {GradeZone} zone
 * @param {number} cssSize wheel diameter in CSS px
 * @param {import("../state.js").Store} store
 * @returns {{ el: HTMLElement, sync: (state: ToneSettings) => void }}
 */
function createWheel(zone, cssSize, store) {
  const root = el("div", "cg-wheel");
  root.style.width = `${cssSize}px`;
  root.style.height = `${cssSize}px`;
  const canvas = /** @type {HTMLCanvasElement} */ (
    document.createElement("canvas")
  );
  drawWheel(canvas, cssSize);
  const puck = el("div", "cg-puck");
  root.append(canvas, puck);
  root.title = `${zone.label.toLowerCase()} hue/saturation`;

  /** @param {PointerEvent} e */
  function pick(e) {
    const rect = root.getBoundingClientRect();
    const R = rect.width / 2;
    const dx = e.clientX - rect.left - R;
    const dy = e.clientY - rect.top - R;
    const sat = Math.min(Math.hypot(dx, dy) / (R - 2), 1);
    const hue = sat === 0 ? 0 : (Math.atan2(-dy, dx) / (2 * Math.PI) + 1) % 1;
    store.set({ [zone.hue]: hue, [zone.sat]: sat });
  }

  root.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    root.setPointerCapture(e.pointerId);
    root.classList.add("dragging");
    pick(e);
  });
  root.addEventListener("pointermove", (e) => {
    if (root.classList.contains("dragging")) pick(e);
  });
  const release = (/** @type {PointerEvent} */ e) => {
    root.classList.remove("dragging");
    if (root.hasPointerCapture(e.pointerId)) {
      root.releasePointerCapture(e.pointerId);
    }
  };
  root.addEventListener("pointerup", release);
  root.addEventListener("pointercancel", release);
  root.addEventListener("dblclick", () => {
    store.set({ [zone.hue]: 0, [zone.sat]: 0 });
  });

  return {
    el: root,
    /** @param {ToneSettings} state */
    sync(state) {
      const hue = /** @type {number} */ (state[zone.hue]);
      const sat = /** @type {number} */ (state[zone.sat]);
      const R = cssSize / 2;
      const a = hue * 2 * Math.PI;
      puck.style.left = `${R + Math.cos(a) * sat * (R - 2)}px`;
      puck.style.top = `${R - Math.sin(a) * sat * (R - 2)}px`;
      const [r, g, b] = wheelColor(hue, sat);
      puck.style.background = `rgb(${r} ${g} ${b})`;
      root.classList.toggle("neutral", sat === 0);
    },
  };
}

/** @type {Record<string, string>} */
const TAB_ICONS = {
  three:
    '<svg viewBox="0 0 18 14" width="18" height="14" aria-hidden="true">' +
    '<circle cx="5" cy="5" r="3.4" fill="#3a4358" stroke="currentColor" stroke-width="1"/>' +
    '<circle cx="13" cy="5" r="3.4" fill="#c7cedd" stroke="currentColor" stroke-width="1"/>' +
    '<circle cx="9" cy="9" r="3.4" fill="#79829a" stroke="currentColor" stroke-width="1"/></svg>',
  SHADOWS:
    '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">' +
    '<circle cx="7" cy="7" r="5" fill="#3a4358" stroke="currentColor" stroke-width="1.2"/></svg>',
  MIDTONES:
    '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">' +
    '<circle cx="7" cy="7" r="5" fill="#79829a" stroke="currentColor" stroke-width="1.2"/></svg>',
  HIGHLIGHTS:
    '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">' +
    '<circle cx="7" cy="7" r="5" fill="#c7cedd" stroke="currentColor" stroke-width="1.2"/></svg>',
};

/**
 * Build the COLOR GRADING section body into `section`.
 * @param {HTMLElement} section
 * @param {import("../state.js").Store} store
 * @param {(def: SliderDef) => HTMLElement} makeRow panel's slider-row
 *   factory; rows it returns are auto-synced and bypass/disable-aware
 */
export function buildGrading(section, store, makeRow) {
  /** @type {{ sync: (state: ToneSettings) => void }[]} */
  const wheels = [];

  // tab strip: 3-way + one tab per zone
  const tabs = el("div", "cg-tabs");
  /** @type {{ btn: HTMLButtonElement, view: HTMLElement }[]} */
  const tabViews = [];
  /** @param {string} name @param {string} icon @param {HTMLElement} view */
  function addTab(name, icon, view) {
    const btn = /** @type {HTMLButtonElement} */ (el("button", "cg-tab"));
    btn.type = "button";
    btn.innerHTML = icon;
    btn.title = name;
    btn.setAttribute("aria-label", name);
    btn.addEventListener("click", () => {
      for (const t of tabViews) {
        t.view.hidden = t.view !== view;
        t.btn.classList.toggle("active", t.view === view);
      }
    });
    tabs.append(btn);
    tabViews.push({ btn, view });
  }

  // 3-way view: three small wheels, label + luminance under each
  const three = el("div", "cg-three");
  for (const zone of GRADE_ZONES) {
    const cell = el("div", "cg-cell");
    const wheel = createWheel(zone, 72, store);
    wheels.push(wheel);
    cell.append(wheel.el, el("div", "cg-zone-label", zone.label));
    cell.append(
      makeRow({
        key: zone.lum,
        label: "LUM",
        min: -100,
        max: 100,
        step: 1,
        scale: 0.01,
        decimals: 0,
      }),
    );
    three.append(cell);
  }
  addTab("3-way", TAB_ICONS.three, three);

  // detail views: one large wheel + hue/sat/luminance sliders per zone
  /** @type {HTMLElement[]} */
  const detailViews = [three];
  for (const zone of GRADE_ZONES) {
    const view = el("div", "cg-detail");
    const wheel = createWheel(zone, 148, store);
    wheels.push(wheel);
    const wrap = el("div", "cg-detail-wheel");
    wrap.append(wheel.el);
    view.append(wrap, el("div", "cg-zone-label", zone.label));
    view.append(
      makeRow({
        key: zone.hue,
        label: "HUE",
        min: 0,
        max: 360,
        step: 1,
        scale: 1 / 360,
        decimals: 0,
        signed: false,
      }),
      makeRow({
        key: zone.sat,
        label: "SAT",
        min: 0,
        max: 100,
        step: 1,
        scale: 0.01,
        decimals: 0,
        signed: false,
      }),
      makeRow({
        key: zone.lum,
        label: "LUM",
        min: -100,
        max: 100,
        step: 1,
        scale: 0.01,
        decimals: 0,
      }),
    );
    view.hidden = true;
    detailViews.push(view);
    addTab(zone.label.toLowerCase(), TAB_ICONS[zone.label], view);
  }
  tabViews[0].btn.classList.add("active");

  section.append(tabs, ...detailViews);

  // blending / balance apply across all zones — always visible
  for (const def of GRADE_SLIDERS) section.append(makeRow(def));

  store.subscribe((state) => {
    for (const wheel of wheels) wheel.sync(state);
  });
  for (const wheel of wheels) wheel.sync(store.get());
}
