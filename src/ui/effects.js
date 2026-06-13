// EFFECTS section UI: a NEGATIVE toggle (photo-negative invert) styled like
// the mask-tool toggle buttons, followed by the GRAIN (Amount / Size /
// Roughness) and NOISE slider rows. The toggle is bespoke — it stores a
// 0/1 number (uniform-compatible) rather than going through the slider
// factory — but it participates in the section's bypass/disable the same
// way the rows do, so the section eye and Revert pick it up automatically.

import { EFFECTS_SLIDERS, EFFECTS_TOGGLE_KEY } from "../state.js";

/**
 * @typedef {import("../state.js").SliderDef} SliderDef
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
 * Build the EFFECTS section body into `section`.
 * @param {HTMLElement} section
 * @param {import("../state.js").Store} store
 * @param {(def: SliderDef) => HTMLElement} makeRow panel's slider-row
 *   factory; rows it returns are auto-synced and bypass/disable-aware
 * @returns {{ toggle: HTMLButtonElement }} the toggle button, so the panel
 *   can disable it alongside the section's inputs
 */
export function buildEffects(section, store, makeRow) {
  // NEGATIVE toggle: a single button styled like the mask-tool toggles.
  const tools = el("div", "effects-tools");
  const toggle = /** @type {HTMLButtonElement} */ (
    el("button", "effects-toggle", "Negative")
  );
  toggle.type = "button";
  toggle.setAttribute("aria-pressed", "false");
  toggle.setAttribute("aria-label", "photo negative (invert)");
  toggle.addEventListener("click", () => {
    const on = store.get()[EFFECTS_TOGGLE_KEY] > 0;
    store.set({ [EFFECTS_TOGGLE_KEY]: on ? 0 : 1 });
  });
  tools.append(toggle);
  section.append(tools);

  // GRAIN + NOISE sliders use the shared, bypass-aware row factory.
  for (const def of EFFECTS_SLIDERS) section.append(makeRow(def));

  // Keep the toggle's pressed state in sync with the store (so Revert,
  // bypass restore, and a fresh open all reflect it).
  store.subscribe((state) => {
    const on = state[EFFECTS_TOGGLE_KEY] > 0;
    toggle.classList.toggle("active", on);
    toggle.setAttribute("aria-pressed", String(on));
  });

  return { toggle };
}
