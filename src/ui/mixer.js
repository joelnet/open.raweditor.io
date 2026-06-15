// HSL color mixer UI: a tab strip of 8 color dots (one per
// hue band) and hue/saturation/luminance sliders for the selected band.
// Dot colors come from the same band centers the pipeline weights with
// (HSL.CENTERS through hueColor()), so the dot you pick is the hue range
// that moves.

import { HSL_BANDS } from "../state.js";
import { HSL } from "../tone/constants.js";
import { hueColor } from "../tone/tone-math.js";

/**
 * @typedef {import("../state.js").SliderDef} SliderDef
 * @typedef {import("../state.js").HslBand} HslBand
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

/** Tab dot color for a band, dimmed like the grading wheels to sit well on
 *  the dark panel.
 * @param {number} index band index into HSL.CENTERS
 */
function bandColor(index) {
  const [r, g, b] = hueColor(HSL.CENTERS[index]);
  const dim = 0.88;
  return `rgb(${Math.round(r * dim * 255)} ${Math.round(g * dim * 255)} ${Math.round(b * dim * 255)})`;
}

/**
 * Build the COLOR MIXER section body into `section`.
 * @param {HTMLElement} section
 * @param {(def: SliderDef) => HTMLElement} makeRow panel's slider-row
 *   factory; rows it returns are auto-synced and bypass/disable-aware
 */
export function buildMixer(section, makeRow) {
  const tabs = el("div", "mx-tabs");
  /** @type {{ btn: HTMLButtonElement, view: HTMLElement }[]} */
  const tabViews = [];

  for (const [index, band] of HSL_BANDS.entries()) {
    const view = el("div", "mx-band");
    view.append(el("div", "mx-band-label", band.label));
    view.append(
      makeRow({
        key: band.hue,
        label: "HUE",
        min: -100,
        max: 100,
        step: 1,
        scale: 0.01,
        decimals: 0,
      }),
      makeRow({
        key: band.sat,
        label: "SATURATION",
        min: -100,
        max: 100,
        step: 1,
        scale: 0.01,
        decimals: 0,
      }),
      makeRow({
        key: band.lum,
        label: "LUMINANCE",
        min: -100,
        max: 100,
        step: 1,
        scale: 0.01,
        decimals: 0,
      }),
    );
    view.hidden = index !== 0;

    const btn = /** @type {HTMLButtonElement} */ (el("button", "mx-tab"));
    btn.type = "button";
    btn.title = band.label.toLowerCase();
    btn.setAttribute("aria-label", `${band.label.toLowerCase()} band`);
    const dot = el("span", "mx-dot");
    dot.style.background = bandColor(index);
    btn.append(dot);
    btn.addEventListener("click", () => {
      for (const t of tabViews) {
        t.view.hidden = t.view !== view;
        t.btn.classList.toggle("active", t.view === view);
      }
    });
    tabs.append(btn);
    tabViews.push({ btn, view });
  }
  tabViews[0].btn.classList.add("active");

  section.append(tabs, ...tabViews.map((t) => t.view));
}
