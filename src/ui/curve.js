// TONE CURVE UI: an editable spline canvas — drag points, click the curve
// to add one (Lightroom-style: the new point lands on the curve at that x),
// drag a point well outside the grid to remove it — plus a channel tab
// strip (ALL / R / G / B), preset chips (LINEAR / MEDIUM / STRONG, the
// classic ACR point curves), and the REFINE SATURATION slider row.
// Channel colors match the histogram's so the two widgets agree.

import { CURVE_SLIDERS } from "../state.js";
import { CURVE } from "../tone/constants.js";
import { curveMap, isIdentityPoints } from "../tone/curve.js";

/**
 * @typedef {import("../state.js").SliderDef} SliderDef
 * @typedef {import("../tone/tone-math.js").ToneSettings} ToneSettings
 * @typedef {import("../tone/curve.js").ToneCurve} ToneCurve
 * @typedef {"master" | "r" | "g" | "b"} CurveChannel
 */

/** @type {readonly { key: CurveChannel, label: string, color: string }[]} */
const CHANNELS = [
  { key: "master", label: "ALL", color: "#d7dce8" },
  { key: "r", label: "R", color: "rgb(225, 85, 85)" },
  { key: "g", label: "G", color: "rgb(120, 205, 100)" },
  { key: "b", label: "B", color: "rgb(95, 140, 235)" },
];

/** @type {readonly { label: string, points: readonly (readonly number[])[] }[]} */
const PRESETS = [
  { label: "LINEAR", points: CURVE.LINEAR },
  { label: "MEDIUM", points: CURVE.MEDIUM_CONTRAST },
  { label: "STRONG", points: CURVE.STRONG_CONTRAST },
];

/** Inner padding (CSS px) so the endpoint dots aren't clipped. */
const PAD = 8;
/** Minimum x distance between control points. */
const MIN_GAP = 0.01;
/** Dragging a point this far (CSS px) outside the grid removes it. */
const REMOVE_MARGIN = 30;

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

/** @param {number} v */
function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

/**
 * @param {import("../tone/curve.js").CurvePoints} points
 * @param {readonly (readonly number[])[]} preset
 */
function matchesPreset(points, preset) {
  if (points.length !== preset.length) return false;
  for (let i = 0; i < points.length; i++) {
    if (
      Math.abs(points[i][0] - preset[i][0]) > 1e-6 ||
      Math.abs(points[i][1] - preset[i][1]) > 1e-6
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Build the TONE CURVE section body into `section`.
 * @param {HTMLElement} section
 * @param {import("../state.js").Store} store
 * @param {(def: SliderDef) => HTMLElement} makeRow panel's slider-row
 *   factory; rows it returns are auto-synced and bypass/disable-aware
 * @param {() => void} onAdjustmentChange
 * @returns {{ buttons: HTMLButtonElement[] }} tab + preset buttons, so the
 *   panel can disable them alongside the section's inputs
 */
export function buildCurve(section, store, makeRow, onAdjustmentChange) {
  /** @type {CurveChannel} */
  let channel = "master";
  /** @type {ToneCurve} */
  let cur = store.get().curve;
  /** Active drag: the dragged point's neighbors (fixed at drag start, so
   *  x-clamping keeps the point order stable) and its current position.
   *  @type {{ others: [number, number][], index: number, x: number,
   *           y: number, out: boolean } | null} */
  let drag = null;

  // --- channel tabs -------------------------------------------------------
  const tabs = el("div", "tc-tabs");
  /** @type {HTMLButtonElement[]} */
  const tabButtons = [];
  for (const ch of CHANNELS) {
    const btn = /** @type {HTMLButtonElement} */ (el("button", "tc-tab"));
    btn.type = "button";
    btn.style.color = ch.color;
    btn.title = `${ch.label} curve`;
    btn.setAttribute("aria-label", `${ch.label.toLowerCase()} curve`);
    btn.addEventListener("click", () => {
      channel = ch.key;
      for (let i = 0; i < CHANNELS.length; i++) {
        tabButtons[i].classList.toggle("active", CHANNELS[i].key === channel);
      }
      sync();
    });
    tabs.append(btn);
    tabButtons.push(btn);
  }
  tabButtons[0].classList.add("active");

  // --- curve canvas -------------------------------------------------------
  const wrap = el("div", "tc-canvas-wrap");
  const canvas = /** @type {HTMLCanvasElement} */ (
    document.createElement("canvas")
  );
  canvas.className = "tc-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "tone curve");
  wrap.append(canvas);

  function draw() {
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    if (w === 0 || h === 0) return; // collapsed section — redrawn on expand
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr))
      canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr))
      canvas.height = Math.round(h * dpr);
    const ctx = /** @type {CanvasRenderingContext2D} */ (
      canvas.getContext("2d")
    );
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pw = w - 2 * PAD;
    const ph = h - 2 * PAD;
    /** @param {number} x */
    const px = (x) => PAD + x * pw;
    /** @param {number} y */
    const py = (y) => PAD + (1 - y) * ph;

    // grid: border + quarter lines, then the identity diagonal
    ctx.strokeStyle = "#262e47";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      ctx.beginPath();
      ctx.moveTo(px(t), py(0));
      ctx.lineTo(px(t), py(1));
      ctx.moveTo(px(0), py(t));
      ctx.lineTo(px(1), py(t));
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    ctx.lineTo(px(1), py(1));
    ctx.stroke();

    // curves: inactive non-identity channels faint, then the active curve
    // and its handles last so nothing can obscure the edit target
    for (const active of [false, true]) {
      for (const ch of CHANNELS) {
        if ((ch.key === channel) !== active) continue;
        const points = cur[ch.key];
        if (!active && isIdentityPoints(points)) continue;
        const f = curveMap(points);
        ctx.strokeStyle = ch.color;
        ctx.globalAlpha = active ? 1 : 0.35;
        ctx.lineWidth = active ? 1.5 : 1;
        ctx.beginPath();
        for (let i = 0; i <= pw; i += 2) {
          const x = i / pw;
          const y = f(x);
          if (i === 0) ctx.moveTo(px(x), py(y));
          else ctx.lineTo(px(x), py(y));
        }
        ctx.stroke();
        if (!active) continue;
        ctx.globalAlpha = 1;
        for (const [x, y] of points) {
          ctx.beginPath();
          ctx.arc(px(x), py(y), 3.5, 0, 2 * Math.PI);
          ctx.fillStyle = "#1b2133";
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Pointer event → curve coords (unclamped). @param {PointerEvent} e */
  function toCurve(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - PAD) / (rect.width - 2 * PAD),
      y: 1 - (e.clientY - rect.top - PAD) / (rect.height - 2 * PAD),
      inside:
        e.clientX > rect.left - REMOVE_MARGIN &&
        e.clientX < rect.right + REMOVE_MARGIN &&
        e.clientY > rect.top - REMOVE_MARGIN &&
        e.clientY < rect.bottom + REMOVE_MARGIN,
    };
  }

  /** Commit the drag state (or a finished set of points) to the store.
   * @param {[number, number][]} points */
  function commit(points) {
    onAdjustmentChange();
    store.set({ curve: { ...cur, [channel]: points } });
  }

  /** The dragged point clamped between its (fixed) neighbors. */
  function dragPoints() {
    const d = /** @type {NonNullable<typeof drag>} */ (drag);
    if (d.out) return d.others.slice();
    const lo = d.index > 0 ? d.others[d.index - 1][0] + MIN_GAP : 0;
    const hi = d.index < d.others.length ? d.others[d.index][0] - MIN_GAP : 1;
    const x = Math.min(Math.max(d.x, lo), Math.max(lo, hi));
    const points = d.others.slice();
    points.splice(d.index, 0, [x, clamp01(d.y)]);
    return points;
  }

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const pos = toCurve(e);
    const points = cur[channel];
    const hit = e.pointerType === "touch" ? 20 : 10;
    const pwPx = rect.width - 2 * PAD;
    const phPx = rect.height - 2 * PAD;
    let index = -1;
    let best = hit;
    for (let i = 0; i < points.length; i++) {
      const dx = (points[i][0] - pos.x) * pwPx;
      const dy = (points[i][1] - pos.y) * phPx;
      const dist = Math.hypot(dx, dy);
      if (dist < best) {
        best = dist;
        index = i;
      }
    }
    /** @type {[number, number][]} */
    const others = points.map(([x, y]) => [x, y]);
    if (index >= 0) {
      others.splice(index, 1);
      drag = {
        others,
        index,
        x: points[index][0],
        y: points[index][1],
        out: false,
      };
    } else {
      if (points.length >= CURVE.MAX_POINTS) return;
      // new points land on the curve at the clicked x (Lightroom-style)
      const x = clamp01(pos.x);
      const y = curveMap(points)(x);
      let at = 0;
      while (at < others.length && others[at][0] < x) at++;
      drag = { others, index: at, x, y, out: false };
    }
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
    commit(dragPoints());
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const pos = toCurve(e);
    drag.x = pos.x;
    drag.y = pos.y;
    // dragging well outside the grid detaches the point (back inside
    // reattaches it); a channel keeps at least its two endpoints
    drag.out = !pos.inside && drag.others.length >= 2;
    commit(dragPoints());
  });
  const release = (/** @type {PointerEvent} */ e) => {
    if (!drag) return;
    drag = null;
    canvas.classList.remove("dragging");
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  // --- preset chips -------------------------------------------------------
  const presets = el("div", "tc-presets");
  /** @type {HTMLButtonElement[]} */
  const presetButtons = [];
  for (const preset of PRESETS) {
    const btn = /** @type {HTMLButtonElement} */ (
      el("button", "tc-chip", preset.label)
    );
    btn.type = "button";
    btn.setAttribute("aria-label", `${preset.label.toLowerCase()} preset`);
    btn.addEventListener("click", () => {
      commit(preset.points.map(([x, y]) => [x, y]));
    });
    presets.append(btn);
    presetButtons.push(btn);
  }

  section.append(tabs, wrap, presets);
  for (const def of CURVE_SLIDERS) section.append(makeRow(def));

  function sync() {
    const points = cur[channel];
    for (let i = 0; i < PRESETS.length; i++) {
      presetButtons[i].classList.toggle(
        "active",
        matchesPreset(points, PRESETS[i].points),
      );
    }
    draw();
  }

  store.subscribe((state) => {
    cur = state.curve;
    sync();
  });
  sync();

  // the canvas has zero size while its section is collapsed — redraw when
  // expanding (or any panel resize) gives it a box
  new ResizeObserver(() => draw()).observe(canvas);

  return { buttons: [...tabButtons, ...presetButtons] };
}
