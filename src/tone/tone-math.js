// Pure-JS tone pipeline. The preview shader in gl/shaders.js implements the
// exact same steps on the GPU; keep the two line-for-line in sync.

import { TONE, INPUT_TRANSFER, LUMA } from "./constants.js";

/**
 * Tone settings, all pre-scaled: exposure in EV (±5), the rest in [-1, +1].
 * @typedef {{ exposure: number, contrast: number, highlights: number,
 *             shadows: number, whites: number, blacks: number }} ToneSettings
 */

export const ZERO_SETTINGS = Object.freeze({
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
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
 * Apply the tone pipeline to one linear-light pixel.
 * Input components may exceed [0,1] (pre-clip highlights); output is
 * display-referred sRGB, clamped to [0,1].
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {ToneSettings} s
 * @returns {[number, number, number]}
 */
export function applyTonePixel(r, g, b, s) {
  // 1. exposure
  const m = Math.pow(2, s.exposure);
  r *= m;
  g *= m;
  b *= m;

  // 2. whites / blacks: levels remap (+whites brightens, +blacks lifts)
  const white = 1 - TONE.WHITES_RANGE * s.whites;
  const black = -TONE.BLACKS_RANGE * s.blacks;
  const range = Math.max(white - black, 1e-4);
  r = (r - black) / range;
  g = (g - black) / range;
  b = (b - black) / range;

  // 3. contrast: power curve pivoting on middle gray
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  if (s.contrast !== 0) {
    const c = s.contrast >= 0 ? 1 + s.contrast : 1 / (1 - s.contrast);
    r = TONE.PIVOT * Math.pow(r / TONE.PIVOT, c);
    g = TONE.PIVOT * Math.pow(g / TONE.PIVOT, c);
    b = TONE.PIVOT * Math.pow(b / TONE.PIVOT, c);
  }

  // 4. highlights / shadows: luminance-masked exposure gain
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

  // 5. clamp + display encode
  return [
    srgbEncode(Math.min(Math.max(r, 0), 1)),
    srgbEncode(Math.min(Math.max(g, 0), 1)),
    srgbEncode(Math.min(Math.max(b, 0), 1)),
  ];
}

/**
 * Tone-map a row range of a decoded LibRaw image into an RGBA8 buffer.
 * Lets the caller (export worker) chunk work and report progress.
 * @param {{ data: Uint16Array | Uint8Array, width: number, height: number,
 *           colors: number, bits: number }} image
 * @param {ToneSettings} settings
 * @param {Uint8ClampedArray} out RGBA8, width*height*4 bytes
 * @param {number} rowStart inclusive
 * @param {number} rowEnd exclusive
 */
export function toneMapRows(image, settings, out, rowStart, rowEnd) {
  const { data, width, colors, bits } = image;
  const maxVal = bits === 16 ? 65535 : 255;
  for (let yRow = rowStart; yRow < rowEnd; yRow++) {
    let src = yRow * width * colors;
    let dst = yRow * width * 4;
    for (let x = 0; x < width; x++) {
      const r = decodeInput(data[src] / maxVal);
      const g = decodeInput(data[src + 1] / maxVal);
      const b = decodeInput(data[src + 2] / maxVal);
      const [or, og, ob] = applyTonePixel(r, g, b, settings);
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
