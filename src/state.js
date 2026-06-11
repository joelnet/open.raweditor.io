// Minimal observable store for tone settings plus the slider definitions
// the panel is generated from. Store values are pre-scaled: exposure in EV,
// everything else in [-1, +1] — the contract shared by the GLSL uniforms
// and tone-math.js.

import { ZERO_SETTINGS } from "./tone/tone-math.js";

/**
 * @typedef {import("./tone/tone-math.js").ToneSettings} ToneSettings
 * @typedef {keyof ToneSettings} SliderKey
 */

/**
 * One slider row. `scale` maps the raw input value to the store value;
 * `reset` is the raw value a double-click restores (default 0); `signed`
 * prefixes positive readouts with "+" (default true).
 * @typedef {{ key: SliderKey, label: string, min: number, max: number,
 *             step: number, scale: number, decimals: number,
 *             reset?: number, signed?: boolean }} SliderDef
 */

/** @type {readonly SliderDef[]} */
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

/** @type {readonly SliderDef[]} */
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

/** @type {readonly SliderDef[]} */
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

/**
 * Color grading zones (Lightroom 3-way): one color wheel (hue/sat) plus a
 * luminance slider per zone. Hues are stored in turns [0, 1), sats in [0, 1].
 * @typedef {{ label: string, hue: SliderKey, sat: SliderKey,
 *             lum: SliderKey }} GradeZone
 * @type {readonly GradeZone[]}
 */
export const GRADE_ZONES = [
  {
    label: "SHADOWS",
    hue: "gradeShadowHue",
    sat: "gradeShadowSat",
    lum: "gradeShadowLum",
  },
  {
    label: "MIDTONES",
    hue: "gradeMidHue",
    sat: "gradeMidSat",
    lum: "gradeMidLum",
  },
  {
    label: "HIGHLIGHTS",
    hue: "gradeHighHue",
    sat: "gradeHighSat",
    lum: "gradeHighLum",
  },
];

/** @type {readonly SliderDef[]} */
export const GRADE_SLIDERS = [
  {
    key: "gradeBlending",
    label: "BLENDING",
    min: 0,
    max: 100,
    step: 1,
    scale: 0.01,
    decimals: 0,
    reset: 50,
    signed: false,
  },
  {
    key: "gradeBalance",
    label: "BALANCE",
    min: -100,
    max: 100,
    step: 1,
    scale: 0.01,
    decimals: 0,
  },
];

/** Every store key the COLOR GRADING section owns (for bypass zeroing). */
export const GRADE_KEYS = /** @type {readonly SliderKey[]} */ ([
  ...GRADE_ZONES.flatMap((z) => [z.hue, z.sat, z.lum]),
  ...GRADE_SLIDERS.map((d) => d.key),
]);

/**
 * Sidebar sections, in display order. `auto` adds an AUTO button; `grading`
 * swaps the default slider list for the color-grading wheel UI.
 * @typedef {{ title: string, sliders: readonly SliderDef[], auto: boolean,
 *             grading?: boolean }} Section
 * @type {readonly Section[]}
 */
export const SECTIONS = [
  { title: "WHITE BALANCE", sliders: WB_SLIDERS, auto: true },
  { title: "TONE", sliders: TONE_SLIDERS, auto: true },
  { title: "COLOR", sliders: COLOR_SLIDERS, auto: false },
  {
    title: "COLOR GRADING",
    sliders: GRADE_SLIDERS,
    auto: false,
    grading: true,
  },
];

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
