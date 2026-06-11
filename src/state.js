// Minimal observable store for tone settings plus the slider definitions
// the panel is generated from. Store values are pre-scaled: exposure in EV,
// everything else in [-1, +1] — the contract shared by the GLSL uniforms
// and tone-math.js.

import { ZERO_SETTINGS } from "./tone/tone-math.js";

/**
 * @typedef {import("./tone/tone-math.js").ToneSettings} ToneSettings
 * @typedef {keyof ToneSettings} SliderKey
 */

export const WB_SLIDERS = /** @type {const} */ ([
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
]);

export const TONE_SLIDERS = /** @type {const} */ ([
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
]);

export const COLOR_SLIDERS = /** @type {const} */ ([
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
]);

/** Sidebar sections, in display order. `auto` adds an AUTO button. */
export const SECTIONS = /** @type {const} */ ([
  { title: "WHITE BALANCE", sliders: WB_SLIDERS, auto: true },
  { title: "TONE", sliders: TONE_SLIDERS, auto: true },
  { title: "COLOR", sliders: COLOR_SLIDERS, auto: false },
]);

export function createStore() {
  /** @type {ToneSettings} */
  const state = { ...ZERO_SETTINGS };
  /** @type {Set<(state: ToneSettings) => void>} */
  const listeners = new Set();

  return {
    /** @returns {ToneSettings} */
    get() {
      return { ...state };
    },
    /** @param {Partial<ToneSettings>} patch */
    set(patch) {
      Object.assign(state, patch);
      for (const fn of listeners) fn({ ...state });
    },
    /**
     * @param {(state: ToneSettings) => void} fn
     * @returns {() => void} unsubscribe
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */
