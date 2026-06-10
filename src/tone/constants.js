// Single source of truth for the tone pipeline. Imported by tone-math.js
// (export path + tests) and interpolated into the GLSL in gl/shaders.js
// (preview path) so the two can never drift.

export const TONE = {
  /** Temp slider ±1 gains red by ±WB_TEMP_EV EV and blue by the opposite. */
  WB_TEMP_EV: 0.75,
  /** Tint slider ±1 (toward magenta) gains green by ∓WB_TINT_EV EV. */
  WB_TINT_EV: 0.5,
  /** Contrast pivot: middle gray in linear light. */
  PIVOT: 0.18,
  /** Whites slider ±1 moves the white point to 1 ∓ WHITES_RANGE. */
  WHITES_RANGE: 0.25,
  /** Blacks slider ±1 moves the black point to ∓ BLACKS_RANGE. */
  BLACKS_RANGE: 0.1,
  /** Max EV of shadows lift / highlights cut at slider ±1. */
  SH_STRENGTH_EV: 1.5,
  /** smoothstep edges (on sqrt-luma) where the shadows mask fades out. */
  SHADOW_MASK: [0.25, 0.6],
  /** smoothstep edges (on sqrt-luma) where the highlights mask fades in. */
  HIGHLIGHT_MASK: [0.5, 0.95],
};

/**
 * Transfer curve of the decoded 16-bit data coming out of LibRaw.
 * "linear" assumes gamm:[1,1] is honored; flip to "bt709" if the decode
 * probe shows LibRaw's default BT.709-ish gamma is applied anyway.
 * @type {"linear" | "bt709"}
 */
export const INPUT_TRANSFER = "linear";

/** Rec.709 luma weights used for the shadows/highlights masks. */
export const LUMA = [0.2126, 0.7152, 0.0722];
