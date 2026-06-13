// Pure-JS tone pipeline. The preview shader in gl/shaders.js implements the
// exact same steps on the GPU; keep the two line-for-line in sync.

import {
  TONE,
  GRADE,
  HSL,
  EFFECTS,
  INPUT_TRANSFER,
  LUMA,
} from "./constants.js";
import { prepareMask, maskWeight } from "./mask-math.js";
import {
  ZERO_GEOMETRY,
  isIdentityGeometry,
  orientedDims,
  coverScale,
} from "./geometry.js";

/**
 * Tone settings, all pre-scaled: exposure in EV (±5), grade hues in turns
 * [0, 1), grade sats and blending in [0, 1], the rest in [-1, +1].
 * `masks` are local adjustments (linear/radial gradients); treat the array
 * as immutable — always replace it, never mutate in place.
 * @typedef {{ temp: number, tint: number, exposure: number, contrast: number,
 *             highlights: number, shadows: number, whites: number,
 *             blacks: number, texture: number, clarity: number,
 *             dehaze: number, vibrance: number, saturation: number,
 *             hslRedHue: number, hslRedSat: number, hslRedLum: number,
 *             hslOrangeHue: number, hslOrangeSat: number,
 *             hslOrangeLum: number, hslYellowHue: number,
 *             hslYellowSat: number, hslYellowLum: number,
 *             hslGreenHue: number, hslGreenSat: number, hslGreenLum: number,
 *             hslAquaHue: number, hslAquaSat: number, hslAquaLum: number,
 *             hslBlueHue: number, hslBlueSat: number, hslBlueLum: number,
 *             hslPurpleHue: number, hslPurpleSat: number,
 *             hslPurpleLum: number, hslMagentaHue: number,
 *             hslMagentaSat: number, hslMagentaLum: number,
 *             gradeShadowHue: number, gradeShadowSat: number,
 *             gradeShadowLum: number, gradeMidHue: number,
 *             gradeMidSat: number, gradeMidLum: number,
 *             gradeHighHue: number, gradeHighSat: number,
 *             gradeHighLum: number, gradeBlending: number,
 *             gradeBalance: number,
 *             invert: number, grainAmount: number, grainSize: number,
 *             grainRoughness: number, noise: number,
 *             masks: readonly import("./mask-math.js").Mask[]
 *           }} ToneSettings
 */

export const ZERO_SETTINGS = Object.freeze({
  temp: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: 0,
  hslRedHue: 0,
  hslRedSat: 0,
  hslRedLum: 0,
  hslOrangeHue: 0,
  hslOrangeSat: 0,
  hslOrangeLum: 0,
  hslYellowHue: 0,
  hslYellowSat: 0,
  hslYellowLum: 0,
  hslGreenHue: 0,
  hslGreenSat: 0,
  hslGreenLum: 0,
  hslAquaHue: 0,
  hslAquaSat: 0,
  hslAquaLum: 0,
  hslBlueHue: 0,
  hslBlueSat: 0,
  hslBlueLum: 0,
  hslPurpleHue: 0,
  hslPurpleSat: 0,
  hslPurpleLum: 0,
  hslMagentaHue: 0,
  hslMagentaSat: 0,
  hslMagentaLum: 0,
  gradeShadowHue: 0,
  gradeShadowSat: 0,
  gradeShadowLum: 0,
  gradeMidHue: 0,
  gradeMidSat: 0,
  gradeMidLum: 0,
  gradeHighHue: 0,
  gradeHighSat: 0,
  gradeHighLum: 0,
  // Lightroom's blending default: tints are identity at sat 0, so 0.5 here
  // keeps ZERO_SETTINGS an identity transform.
  gradeBlending: 0.5,
  gradeBalance: 0,
  // EFFECTS: identity — negative off, grain/noise off (0).
  invert: 0,
  grainAmount: 0,
  grainSize: 0,
  grainRoughness: 0,
  noise: 0,
  masks: Object.freeze([]),
});

/**
 * @param {number} e0
 * @param {number} e1
 * @param {number} x
 */
function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Linear [0,1] → sRGB-encoded [0,1].
 * @param {number} c
 */
export function srgbEncode(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * sRGB-encoded [0,1] → linear [0,1].
 * @param {number} c
 */
export function srgbDecode(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// --- shared display-referred post effects (grain / noise / invert) -------
// These run after color grading on the final sRGB-encoded RGB and need the
// pixel position, which applyTonePixel doesn't get. The shader inlines the
// identical math in main() (using v_uv and u_frame); toneMapRows calls
// applyDisplayEffects below with fx,fy,fw,fh. The hash and value noise are
// kept in 32-bit unsigned integer arithmetic so JS (Math.imul + >>> 0) and
// GLSL (uint) produce bit-identical results, and everything keys off
// FRAME-normalized coordinates so the downscaled preview and the full-res
// export show grain/noise of the same visual size — no time, no RNG.

/**
 * Integer hash of three 32-bit lanes → [0, 1). A small xorshift/multiply
 * mix (IQ/Wang-style); `salt` decorrelates the grain octaves and the three
 * chroma-noise channels. Must stay in uint arithmetic to match the shader.
 * @param {number} x @param {number} y @param {number} salt
 */
function hash31(x, y, salt) {
  let h = (x >>> 0) ^ Math.imul(y >>> 0, 0x9e3779b1);
  h = (h >>> 0) ^ Math.imul(salt >>> 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296; // 2^32 → [0, 1)
}

/** smoothstep(0,1,t) — the value-noise interpolant. @param {number} t */
function fade(t) {
  const u = Math.min(Math.max(t, 0), 1);
  return u * u * (3 - 2 * u);
}

/**
 * Bilinearly-interpolated value noise in [-1, 1] at frame-normalized (u, v)
 * on a `grid`-cell lattice. The four lattice corners are hashed by integer
 * cell index, so any resolution sampling the same (u, v) hits the same
 * cells — preview/export parity.
 * @param {number} u @param {number} v frame-normalized [0, 1]
 * @param {number} grid cells across the frame
 * @param {number} salt octave/channel decorrelation
 */
function valueNoise(u, v, grid, salt) {
  const gx = u * grid;
  const gy = v * grid;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = fade(gx - x0);
  const fy = fade(gy - y0);
  const c00 = hash31(x0, y0, salt);
  const c10 = hash31(x0 + 1, y0, salt);
  const c01 = hash31(x0, y0 + 1, salt);
  const c11 = hash31(x0 + 1, y0 + 1, salt);
  const top = c00 + (c10 - c00) * fx;
  const bot = c01 + (c11 - c01) * fx;
  return (top + (bot - top) * fy) * 2 - 1; // [0,1) → [-1, 1)
}

/**
 * Apply grain, chromatic noise, and the photo-negative invert to one
 * display-referred (sRGB-encoded) pixel. Inlined identically in the
 * fragment shader; shared by toneMapRows and the unit tests so the three
 * effects can never drift between the preview and the export.
 * @param {number} r @param {number} g @param {number} b sRGB-encoded [0,1]
 * @param {ToneSettings} s
 * @param {number} u @param {number} v frame-normalized pixel coords [0,1]
 * @param {number} fw @param {number} fh frame size in px (for aspect)
 * @returns {[number, number, number]}
 */
export function applyDisplayEffects(r, g, b, s, u, v, fw, fh) {
  // Keep cells square: stretch v by the frame aspect so a "cell" is the
  // same physical size horizontally and vertically.
  const aspect = fh > 0 ? fh / fw : 1;
  const vv = v * aspect;

  // grain: monochromatic luminance perturbation, midtone-weighted, with a
  // second finer octave mixed in by Roughness (fractal value noise).
  if (s.grainAmount !== 0) {
    const grid =
      EFFECTS.GRAIN_GRID_BASE / Math.pow(EFFECTS.GRAIN_GRID_RANGE, s.grainSize);
    const n1 = valueNoise(u, vv, grid, 0);
    const n2 = valueNoise(u, vv, grid * EFFECTS.GRAIN_OCTAVE2, 1);
    const rough = Math.min(Math.max(s.grainRoughness, 0), 1);
    const mix = EFFECTS.GRAIN_ROUGHNESS_MIX * rough;
    const n = n1 * (1 - mix) + n2 * mix;
    // midtone bias on display luma — fades the grain in shadows/highlights
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    const mid = Math.pow(
      Math.min(Math.max(4 * y * (1 - y), 0), 1),
      EFFECTS.GRAIN_MIDTONE,
    );
    const d = s.grainAmount * EFFECTS.GRAIN_STRENGTH * n * mid;
    r += d;
    g += d;
    b += d;
  }

  // noise (positive half of the bipolar slider): fine, per-channel chromatic
  // noise. Negative noise is denoise and runs in the presence prepass.
  if (s.noise > 0) {
    const grid = EFFECTS.NOISE_GRID;
    const amp = s.noise * EFFECTS.NOISE_STRENGTH;
    r += valueNoise(u, vv, grid, 2) * amp;
    g += valueNoise(u, vv, grid, 3) * amp;
    b += valueNoise(u, vv, grid, 4) * amp;
  }

  r = Math.min(Math.max(r, 0), 1);
  g = Math.min(Math.max(g, 0), 1);
  b = Math.min(Math.max(b, 0), 1);

  // invert: display-referred photo negative — always the final operation.
  if (s.invert) {
    r = 1 - r;
    g = 1 - g;
    b = 1 - b;
  }
  return [r, g, b];
}

/**
 * Decode one normalized sample from LibRaw output to linear light,
 * according to INPUT_TRANSFER (see constants.js).
 * @param {number} v normalized [0,1]
 */
export function decodeInput(v) {
  if (INPUT_TRANSFER === "linear") return v;
  // Inverse BT.709 OETF (LibRaw default gamma 2.222 with 4.5 toe slope).
  return v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45);
}

/**
 * Encode one linear-light sample back to LibRaw's transfer curve — the
 * inverse of decodeInput(), used when the presence pre-pass writes its
 * result back into the decoded buffer.
 * @param {number} v linear [0,1]
 */
export function encodeInput(v) {
  if (INPUT_TRANSFER === "linear") return v;
  // BT.709 OETF (breakpoint 0.018 = 0.081 / 4.5).
  return v < 0.018 ? v * 4.5 : 1.099 * Math.pow(v, 0.45) - 0.099;
}

/**
 * Pure wheel hue → RGB (the hexagonal hue ramp; hsl(h, 100%, 50%)).
 * Shared by the grading pipeline and the color-wheel UI so the puck color
 * always matches the applied tint.
 * @param {number} h hue in turns [0, 1)
 * @returns {[number, number, number]}
 */
export function hueColor(h) {
  const t = h - Math.floor(h);
  const r = Math.min(Math.max(Math.abs(6 * t - 3) - 1, 0), 1);
  const g = Math.min(Math.max(2 - Math.abs(6 * t - 2), 0), 1);
  const b = Math.min(Math.max(2 - Math.abs(6 * t - 4), 0), 1);
  return [r, g, b];
}

/**
 * Settings keys of the color mixer's bands as [hue, sat, lum] triples, in
 * HSL.CENTERS order (red → magenta). Shared with the renderer, which packs
 * the same triples into the u_hsl uniform array.
 * @type {readonly (readonly [SettingsKey, SettingsKey, SettingsKey])[]}
 */
export const HSL_BAND_KEYS = /** @type {const} */ ([
  ["hslRedHue", "hslRedSat", "hslRedLum"],
  ["hslOrangeHue", "hslOrangeSat", "hslOrangeLum"],
  ["hslYellowHue", "hslYellowSat", "hslYellowLum"],
  ["hslGreenHue", "hslGreenSat", "hslGreenLum"],
  ["hslAquaHue", "hslAquaSat", "hslAquaLum"],
  ["hslBlueHue", "hslBlueSat", "hslBlueLum"],
  ["hslPurpleHue", "hslPurpleSat", "hslPurpleLum"],
  ["hslMagentaHue", "hslMagentaSat", "hslMagentaLum"],
]);

/** @typedef {Exclude<keyof ToneSettings, "masks">} SettingsKey */

/**
 * Pegtop soft-light blend: smooth, identity at blend 0.5, and pins black
 * and white so tints never wash out the endpoints.
 * @param {number} a base (display-referred [0,1])
 * @param {number} b blend
 */
function softLight(a, b) {
  return (1 - 2 * b) * a * a + 2 * b * a;
}

/**
 * Color grading zone weights at one sqrt-luma value. Blending feathers the
 * mask edges; balance > 0 extends the highlights zone into darker tones
 * (and shrinks the shadows zone), < 0 the reverse.
 * @param {number} ye sqrt-luma [0, 1]
 * @param {number} blending [0, 1]
 * @param {number} balance [-1, 1]
 * @returns {[number, number, number]} shadow, midtone, highlight weights
 */
export function gradeWeights(ye, blending, balance) {
  const wid = GRADE.WIDTH[0] + (GRADE.WIDTH[1] - GRADE.WIDTH[0]) * blending;
  const shift = GRADE.BALANCE_SHIFT * balance;
  const sC = GRADE.SHADOW_CENTER - shift;
  const hC = GRADE.HIGHLIGHT_CENTER - shift;
  const wS = 1 - smoothstep(sC - wid, sC + wid, ye);
  const wH = smoothstep(hC - wid, hC + wid, ye);
  return [wS, (1 - wS) * (1 - wH), wH];
}

/**
 * Apply one mask's local adjustments to a linear-light pixel, with every
 * strength parameter scaled by the mask weight `m` (the darktable
 * graduatednd model: exposure stays additive in EV inside the mask, and
 * the result is continuous in both the weight and the sliders). The ops
 * and their order mirror global steps 1–6; the only difference is that
 * vibrance/saturation runs unclamped here (mid-pipeline values may exceed
 * 1 — the global clamp happens later, at step 6).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {import("./mask-math.js").MaskAdjustments} a
 * @param {number} m mask weight [0, 1]
 * @returns {[number, number, number]}
 */
function applyMaskAdjust(r, g, b, a, m) {
  // 1. white balance
  if (a.temp !== 0 || a.tint !== 0) {
    r *= Math.pow(2, TONE.WB_TEMP_EV * a.temp * m);
    b *= Math.pow(2, -TONE.WB_TEMP_EV * a.temp * m);
    g *= Math.pow(2, -TONE.WB_TINT_EV * a.tint * m);
  }

  // 2. exposure
  if (a.exposure !== 0) {
    const gain = Math.pow(2, a.exposure * m);
    r *= gain;
    g *= gain;
    b *= gain;
  }

  // 3. whites / blacks
  if (a.whites !== 0 || a.blacks !== 0) {
    const white = 1 - TONE.WHITES_RANGE * a.whites * m;
    const black = -TONE.BLACKS_RANGE * a.blacks * m;
    const range = Math.max(white - black, 1e-4);
    r = (r - black) / range;
    g = (g - black) / range;
    b = (b - black) / range;
  }

  // 4. contrast
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  const cc = a.contrast * m;
  if (cc !== 0) {
    const c = cc >= 0 ? 1 + cc : 1 / (1 - cc);
    r = TONE.PIVOT * Math.pow(r / TONE.PIVOT, c);
    g = TONE.PIVOT * Math.pow(g / TONE.PIVOT, c);
    b = TONE.PIVOT * Math.pow(b / TONE.PIVOT, c);
  }

  // 5. highlights / shadows
  if (a.shadows !== 0 || a.highlights !== 0) {
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    const ye = Math.sqrt(Math.min(Math.max(y, 0), 1));
    const mS = 1 - smoothstep(TONE.SHADOW_MASK[0], TONE.SHADOW_MASK[1], ye);
    const mH = smoothstep(TONE.HIGHLIGHT_MASK[0], TONE.HIGHLIGHT_MASK[1], ye);
    const gain = Math.pow(
      2,
      TONE.SH_STRENGTH_EV * (a.shadows * mS + a.highlights * mH) * m,
    );
    r *= gain;
    g *= gain;
    b *= gain;
  }

  // 6. vibrance / saturation
  if (a.vibrance !== 0 || a.saturation !== 0) {
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    const w = a.vibrance >= 0 ? 1 - sat : sat;
    const factor = Math.max(
      (1 + a.saturation * m) * (1 + a.vibrance * m * w),
      0,
    );
    r = y + (r - y) * factor;
    g = y + (g - y) * factor;
    b = y + (b - y) * factor;
  }

  return [r, g, b];
}

/**
 * Apply the tone pipeline to one linear-light pixel.
 * Input components may exceed [0,1] (pre-clip highlights); output is
 * display-referred sRGB, clamped to [0,1].
 * `maskWeights` holds the local-mask weight at this pixel for each entry
 * of `s.masks` (computed by the caller, which knows the pixel position).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {ToneSettings} s
 * @param {ArrayLike<number>} [maskWeights]
 * @returns {[number, number, number]}
 */
export function applyTonePixel(r, g, b, s, maskWeights) {
  // 1. white balance: +temp warms (red up, blue down), +tint goes magenta
  if (s.temp !== 0 || s.tint !== 0) {
    r *= Math.pow(2, TONE.WB_TEMP_EV * s.temp);
    b *= Math.pow(2, -TONE.WB_TEMP_EV * s.temp);
    g *= Math.pow(2, -TONE.WB_TINT_EV * s.tint);
  }

  // 2. exposure
  const m = Math.pow(2, s.exposure);
  r *= m;
  g *= m;
  b *= m;

  // 3. whites / blacks: levels remap (+whites brightens, +blacks lifts)
  const white = 1 - TONE.WHITES_RANGE * s.whites;
  const black = -TONE.BLACKS_RANGE * s.blacks;
  const range = Math.max(white - black, 1e-4);
  r = (r - black) / range;
  g = (g - black) / range;
  b = (b - black) / range;

  // 4. contrast: power curve pivoting on middle gray
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  if (s.contrast !== 0) {
    const c = s.contrast >= 0 ? 1 + s.contrast : 1 / (1 - s.contrast);
    r = TONE.PIVOT * Math.pow(r / TONE.PIVOT, c);
    g = TONE.PIVOT * Math.pow(g / TONE.PIVOT, c);
    b = TONE.PIVOT * Math.pow(b / TONE.PIVOT, c);
  }

  // 5. highlights / shadows: luminance-masked exposure gain
  if (s.shadows !== 0 || s.highlights !== 0) {
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    const ye = Math.sqrt(Math.min(Math.max(y, 0), 1));
    const mS = 1 - smoothstep(TONE.SHADOW_MASK[0], TONE.SHADOW_MASK[1], ye);
    const mH = smoothstep(TONE.HIGHLIGHT_MASK[0], TONE.HIGHLIGHT_MASK[1], ye);
    const gain = Math.pow(
      2,
      TONE.SH_STRENGTH_EV * (s.shadows * mS + s.highlights * mH),
    );
    r *= gain;
    g *= gain;
    b *= gain;
  }

  // 5.5 local masks: each mask's own adjustment set, applied through its
  // per-pixel weight (Lightroom layering: locals stack on the globals)
  if (maskWeights && s.masks) {
    for (let i = 0; i < s.masks.length; i++) {
      const m = maskWeights[i];
      if (m <= 0) continue;
      [r, g, b] = applyMaskAdjust(r, g, b, s.masks[i].adjustments, m);
    }
  }

  // 6. vibrance / saturation: scale chroma around Rec.709 luma. Vibrance is
  // weighted by 1 - HSV saturation so already-vivid pixels are protected
  // (darktable velvia-style); negative vibrance tames the most saturated
  // colors first.
  r = Math.min(Math.max(r, 0), 1);
  g = Math.min(Math.max(g, 0), 1);
  b = Math.min(Math.max(b, 0), 1);
  if (s.vibrance !== 0 || s.saturation !== 0) {
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    const w = s.vibrance >= 0 ? 1 - sat : sat;
    const factor = Math.max((1 + s.saturation) * (1 + s.vibrance * w), 0);
    r = y + (r - y) * factor;
    g = y + (g - y) * factor;
    b = y + (b - y) * factor;
  }

  // 6.5 HSL color mixer: per-hue-band hue rotation, saturation scale, and
  // luminance gain, in HSV over the display-referred (sRGB-encoded) values
  // — hue computed on linear RGB would disagree with the colors users see
  // (RawTherapee's HSV equalizer encodes for the same reason). A pixel's
  // hue selects its two adjacent bands; their adjustments crossfade with a
  // smoothstep (weights always sum to 1 — no gaps, no banding) and apply
  // once. Hue and luminance are gated by saturation so neutral pixels,
  // whose hue is noise, never move; the sat gain self-gates (× sat).
  let mixing = false;
  for (const band of HSL_BAND_KEYS) {
    if (s[band[0]] !== 0 || s[band[1]] !== 0 || s[band[2]] !== 0) {
      mixing = true;
      break;
    }
  }
  if (mixing) {
    const er = srgbEncode(Math.min(Math.max(r, 0), 1));
    const eg = srgbEncode(Math.min(Math.max(g, 0), 1));
    const eb = srgbEncode(Math.min(Math.max(b, 0), 1));
    const mx = Math.max(er, eg, eb);
    const mn = Math.min(er, eg, eb);
    const ch = mx - mn;
    if (ch > 1e-9) {
      let h;
      if (mx === er) h = (eg - eb) / ch / 6;
      else if (mx === eg) h = (2 + (eb - er) / ch) / 6;
      else h = (4 + (er - eg) / ch) / 6;
      if (h < 0) h += 1;
      const sat = ch / mx;
      // red's center sits at hue 0, so every h lands in exactly one
      // segment [center_i, center_i+1) with the last wrapping back to red
      let seg = HSL_BAND_KEYS.length - 1;
      for (let k = 0; k + 1 < HSL.CENTERS.length; k++) {
        if (h < HSL.CENTERS[k + 1]) {
          seg = k;
          break;
        }
      }
      const c1 = seg + 1 < HSL.CENTERS.length ? HSL.CENTERS[seg + 1] : 1;
      const t = smoothstep(HSL.CENTERS[seg], c1, h);
      const lo = HSL_BAND_KEYS[seg];
      const hi = HSL_BAND_KEYS[(seg + 1) % HSL_BAND_KEYS.length];
      const aw = smoothstep(HSL.SAT_FEATHER[0], HSL.SAT_FEATHER[1], sat);
      const dH = (s[lo[0]] * (1 - t) + s[hi[0]] * t) * HSL.HUE_RANGE * aw;
      const dS = s[lo[1]] * (1 - t) + s[hi[1]] * t;
      const dL = (s[lo[2]] * (1 - t) + s[hi[2]] * t) * aw;
      const s2 = Math.min(Math.max(sat * (1 + dS), 0), 1);
      const [hr, hg, hb] = hueColor(h + dH);
      const gain = Math.pow(2, HSL.LUM_EV * dL);
      r = Math.min(srgbDecode(mx * (1 + (hr - 1) * s2)) * gain, 1);
      g = Math.min(srgbDecode(mx * (1 + (hg - 1) * s2)) * gain, 1);
      b = Math.min(srgbDecode(mx * (1 + (hb - 1) * s2)) * gain, 1);
    } else {
      r = Math.min(Math.max(r, 0), 1);
      g = Math.min(Math.max(g, 0), 1);
      b = Math.min(Math.max(b, 0), 1);
    }
  }

  // 7. color grading: per-zone luminance gain (linear light), then per-zone
  // soft-light tint on the display-referred values. Masks are computed once,
  // before the luminance gain moves the pixel.
  const grading =
    s.gradeShadowSat !== 0 ||
    s.gradeMidSat !== 0 ||
    s.gradeHighSat !== 0 ||
    s.gradeShadowLum !== 0 ||
    s.gradeMidLum !== 0 ||
    s.gradeHighLum !== 0;
  if (grading) {
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    const ye = Math.sqrt(Math.min(Math.max(y, 0), 1));
    const [wS, wM, wH] = gradeWeights(ye, s.gradeBlending, s.gradeBalance);
    const gain = Math.pow(
      2,
      GRADE.LUM_EV *
        (s.gradeShadowLum * wS + s.gradeMidLum * wM + s.gradeHighLum * wH),
    );
    r = Math.min(Math.max(r * gain, 0), 1);
    g = Math.min(Math.max(g * gain, 0), 1);
    b = Math.min(Math.max(b * gain, 0), 1);
    let er = srgbEncode(r);
    let eg = srgbEncode(g);
    let eb = srgbEncode(b);
    const zones = /** @type {const} */ ([
      [s.gradeShadowHue, s.gradeShadowSat * wS],
      [s.gradeMidHue, s.gradeMidSat * wM],
      [s.gradeHighHue, s.gradeHighSat * wH],
    ]);
    for (const [hue, amount] of zones) {
      if (amount === 0) continue;
      const [tr, tg, tb] = hueColor(hue);
      er = softLight(er, 0.5 + (tr - 0.5) * amount);
      eg = softLight(eg, 0.5 + (tg - 0.5) * amount);
      eb = softLight(eb, 0.5 + (tb - 0.5) * amount);
    }
    return [
      Math.min(Math.max(er, 0), 1),
      Math.min(Math.max(eg, 0), 1),
      Math.min(Math.max(eb, 0), 1),
    ];
  }

  // 8. clamp + display encode
  return [
    srgbEncode(Math.min(Math.max(r, 0), 1)),
    srgbEncode(Math.min(Math.max(g, 0), 1)),
    srgbEncode(Math.min(Math.max(b, 0), 1)),
  ];
}

/**
 * Normalized crop rect in image UV space (x/y/w/h in [0,1], y = 0 at the
 * top) — the same convention as the renderer's ViewRect.
 * @typedef {{ x: number, y: number, w: number, h: number }} CropRect
 */

/**
 * Map a normalized crop rect onto an image's pixel grid. Always returns at
 * least 1×1 and stays inside the image regardless of rounding; a null crop
 * (or the full-frame rect) yields the whole image.
 * @param {CropRect | null | undefined} crop
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number, w: number, h: number }} pixel rect
 */
export function cropPixelRect(crop, width, height) {
  if (!crop) return { x: 0, y: 0, w: width, h: height };
  const clamp = (
    /** @type {number} */ v,
    /** @type {number} */ lo,
    /** @type {number} */ hi,
  ) => Math.min(Math.max(v, lo), hi);
  const x0 = clamp(Math.round(crop.x * width), 0, width - 1);
  const y0 = clamp(Math.round(crop.y * height), 0, height - 1);
  const x1 = clamp(Math.round((crop.x + crop.w) * width), x0 + 1, width);
  const y1 = clamp(Math.round((crop.y + crop.h) * height), y0 + 1, height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Tone-map a row range of a decoded LibRaw image into an RGBA buffer,
 * optionally windowed to a pixel crop rect. `out` is rect-sized
 * (rect.w × rect.h × 4) and rowStart/rowEnd index rows of the rect, not
 * the source image. Lets the caller (export worker) chunk work and report
 * progress. With a non-identity `geometry`, the rect lives on the
 * *oriented* (frame) pixel grid and source pixels are sampled through the
 * orientation + straighten transform (bilinear in linear light).
 * @param {{ data: Uint16Array | Uint8Array, width: number, height: number,
 *           colors: number, bits: number }} image
 * @param {ToneSettings} settings
 * @param {Uint8ClampedArray | Uint16Array} out RGBA samples,
 *   rect.w*rect.h*4 long — 8-bit or 16-bit sRGB-encoded per the array type
 * @param {number} rowStart inclusive, in rect rows
 * @param {number} rowEnd exclusive, in rect rows
 * @param {{ x: number, y: number, w: number, h: number }} [rect] pixel
 *   crop on the frame grid; defaults to the full frame
 * @param {import("./geometry.js").Geometry} [geometry]
 */
export function toneMapRows(
  image,
  settings,
  out,
  rowStart,
  rowEnd,
  rect,
  geometry = ZERO_GEOMETRY,
) {
  const { data, width, height, colors, bits } = image;
  const identity = isIdentityGeometry(geometry);
  const frame = orientedDims(geometry.orient, width, height);
  const rx = rect ? rect.x : 0;
  const ry = rect ? rect.y : 0;
  const rw = rect ? rect.w : frame.width;
  const maxVal = bits === 16 ? 65535 : 255;
  // Uint8ClampedArray rounds on assignment; Uint16Array truncates, so the
  // 16-bit path adds 0.5 to round (applyTonePixel output is clamped [0,1]).
  const outMax = out instanceof Uint16Array ? 65535 : 255;
  const outBias = out instanceof Uint16Array ? 0.5 : 0;
  // Mask geometry is normalized to the full frame, so weights are computed
  // from uncropped frame coordinates (mirrors the shader, which evaluates
  // masks at v_uv against u_frame).
  const masks = settings.masks?.length ? settings.masks : null;
  const prepared = masks
    ? masks.map((mk) => prepareMask(mk, frame.width, frame.height))
    : null;
  const weights = masks ? new Float64Array(masks.length) : undefined;

  // Straighten transform constants (mirrors frameToSource in geometry.js,
  // inlined to keep the per-pixel path allocation-free).
  const fw = frame.width;
  const fh = frame.height;
  const orient = geometry.orient & 3;
  const flipH = geometry.flipH;
  const flipV = geometry.flipV;
  const rad = (geometry.angle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const inv = 1 / coverScale(geometry.angle, fw, fh);

  /**
   * Bilinear sample of the source at (sx, sy) px, decoded to linear light.
   * @param {number} sx @param {number} sy
   * @returns {[number, number, number]}
   */
  const sample = [0, 0, 0];
  /** @param {number} sx @param {number} sy frame→source px, bilinear */
  function sampleSource(sx, sy) {
    const u = sx - 0.5;
    const v = sy - 0.5;
    const xf = Math.floor(u);
    const yf = Math.floor(v);
    const tx = u - xf;
    const ty = v - yf;
    const x0 = Math.min(Math.max(xf, 0), width - 1);
    const y0 = Math.min(Math.max(yf, 0), height - 1);
    const x1 = Math.min(Math.max(xf + 1, 0), width - 1);
    const y1 = Math.min(Math.max(yf + 1, 0), height - 1);
    const i00 = (y0 * width + x0) * colors;
    const i10 = (y0 * width + x1) * colors;
    const i01 = (y1 * width + x0) * colors;
    const i11 = (y1 * width + x1) * colors;
    for (let c = 0; c < 3; c++) {
      const a =
        decodeInput(data[i00 + c] / maxVal) * (1 - tx) +
        decodeInput(data[i10 + c] / maxVal) * tx;
      const b =
        decodeInput(data[i01 + c] / maxVal) * (1 - tx) +
        decodeInput(data[i11 + c] / maxVal) * tx;
      sample[c] = a * (1 - ty) + b * ty;
    }
  }

  for (let yRow = rowStart; yRow < rowEnd; yRow++) {
    let src = ((yRow + ry) * width + rx) * colors;
    let dst = yRow * rw * 4;
    const fy = yRow + ry + 0.5;
    for (let x = 0; x < rw; x++) {
      const fx = x + rx + 0.5;
      let r, g, b;
      if (identity) {
        r = decodeInput(data[src] / maxVal);
        g = decodeInput(data[src + 1] / maxVal);
        b = decodeInput(data[src + 2] / maxVal);
      } else {
        // flip first, in frame space (mirrors frameToSource in geometry.js)
        let qx = flipH ? fw - fx : fx;
        let qy = flipV ? fh - fy : fy;
        if (sinA !== 0) {
          const px = qx - fw / 2;
          const py = qy - fh / 2;
          qx = (cosA * px + sinA * py) * inv + fw / 2;
          qy = (-sinA * px + cosA * py) * inv + fh / 2;
        }
        if (orient === 1) sampleSource(qy, height - qx);
        else if (orient === 2) sampleSource(width - qx, height - qy);
        else if (orient === 3) sampleSource(width - qy, qx);
        else sampleSource(qx, qy);
        r = sample[0];
        g = sample[1];
        b = sample[2];
      }
      if (prepared && weights) {
        for (let j = 0; j < prepared.length; j++) {
          weights[j] = maskWeight(prepared[j], fx, fy);
        }
      }
      let [or, og, ob] = applyTonePixel(r, g, b, settings, weights);
      // Shared display-referred post-step (grain / noise / invert), keyed
      // off frame-normalized coords so it matches the GPU preview at any
      // resolution — inlined identically in the fragment shader's main().
      [or, og, ob] = applyDisplayEffects(
        or,
        og,
        ob,
        settings,
        fx / fw,
        fy / fh,
        fw,
        fh,
      );
      out[dst] = or * outMax + outBias;
      out[dst + 1] = og * outMax + outBias;
      out[dst + 2] = ob * outMax + outBias;
      out[dst + 3] = outMax;
      src += colors;
      dst += 4;
    }
  }
}
