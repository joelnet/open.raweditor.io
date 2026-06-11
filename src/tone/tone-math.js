// Pure-JS tone pipeline. The preview shader in gl/shaders.js implements the
// exact same steps on the GPU; keep the two line-for-line in sync.

import { TONE, GRADE, INPUT_TRANSFER, LUMA } from "./constants.js";
import { prepareMask, maskWeight } from "./mask-math.js";

/**
 * Tone settings, all pre-scaled: exposure in EV (±5), grade hues in turns
 * [0, 1), grade sats and blending in [0, 1], the rest in [-1, +1].
 * `masks` are local adjustments (linear/radial gradients); treat the array
 * as immutable — always replace it, never mutate in place.
 * @typedef {{ temp: number, tint: number, exposure: number, contrast: number,
 *             highlights: number, shadows: number, whites: number,
 *             blacks: number, vibrance: number, saturation: number,
 *             gradeShadowHue: number, gradeShadowSat: number,
 *             gradeShadowLum: number, gradeMidHue: number,
 *             gradeMidSat: number, gradeMidLum: number,
 *             gradeHighHue: number, gradeHighSat: number,
 *             gradeHighLum: number, gradeBlending: number,
 *             gradeBalance: number,
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
  vibrance: 0,
  saturation: 0,
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
 * Tone-map a row range of a decoded LibRaw image into an RGBA8 buffer,
 * optionally windowed to a pixel crop rect. `out` is rect-sized
 * (rect.w × rect.h × 4) and rowStart/rowEnd index rows of the rect, not
 * the source image. Lets the caller (export worker) chunk work and report
 * progress.
 * @param {{ data: Uint16Array | Uint8Array, width: number, height: number,
 *           colors: number, bits: number }} image
 * @param {ToneSettings} settings
 * @param {Uint8ClampedArray} out RGBA8, rect.w*rect.h*4 bytes
 * @param {number} rowStart inclusive, in rect rows
 * @param {number} rowEnd exclusive, in rect rows
 * @param {{ x: number, y: number, w: number, h: number }} [rect] pixel
 *   crop; defaults to the full image
 */
export function toneMapRows(image, settings, out, rowStart, rowEnd, rect) {
  const { data, width, height, colors, bits } = image;
  const rx = rect ? rect.x : 0;
  const ry = rect ? rect.y : 0;
  const rw = rect ? rect.w : width;
  const maxVal = bits === 16 ? 65535 : 255;
  // Mask geometry is normalized to the full image, so weights are computed
  // from uncropped pixel coordinates.
  const masks = settings.masks?.length ? settings.masks : null;
  const prepared = masks
    ? masks.map((mk) => prepareMask(mk, width, height))
    : null;
  const weights = masks ? new Float64Array(masks.length) : undefined;
  for (let yRow = rowStart; yRow < rowEnd; yRow++) {
    let src = ((yRow + ry) * width + rx) * colors;
    let dst = yRow * rw * 4;
    const py = yRow + ry + 0.5;
    for (let x = 0; x < rw; x++) {
      const r = decodeInput(data[src] / maxVal);
      const g = decodeInput(data[src + 1] / maxVal);
      const b = decodeInput(data[src + 2] / maxVal);
      if (prepared && weights) {
        const px = x + rx + 0.5;
        for (let j = 0; j < prepared.length; j++) {
          weights[j] = maskWeight(prepared[j], px, py);
        }
      }
      const [or, og, ob] = applyTonePixel(r, g, b, settings, weights);
      // Uint8ClampedArray assignment rounds to nearest on its own.
      out[dst] = or * 255;
      out[dst + 1] = og * 255;
      out[dst + 2] = ob * 255;
      out[dst + 3] = 255;
      src += colors;
      dst += 4;
    }
  }
}
