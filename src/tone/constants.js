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
 * Color mixer (Lightroom HSL panel): per-band hue / saturation / luminance.
 * The algorithm follows the open-source consensus: HSV over display-referred
 * (sRGB-encoded) RGB à la RawTherapee's HSV equalizer; a pixel's hue
 * selects the two adjacent bands and smoothstep-crossfades their
 * *adjustments* before applying once (FlexMonkey MultiBandHSV, GIMP
 * hue-saturation — interpolating results instead breaks at the red/magenta
 * wraparound, GIMP bug #527085); hue shifts additively, saturation is a
 * gain, luminance an EV gain in linear light (darktable color zones).
 * Hue and luminance are gated by saturation so near-neutral pixels — whose
 * hue is sensor noise — never move (darktable color equalizer's logistic
 * gate); the saturation gain self-gates because it multiplies sat.
 */
export const HSL = {
  /** Band center hues in turns: red, orange, yellow, green, aqua, blue,
   *  purple, magenta. Non-uniform on purpose — Lightroom keeps the warm
   *  (skin-tone) bands narrow and the green–blue bands wide. */
  CENTERS: [
    0,
    30 / 360,
    60 / 360,
    120 / 360,
    180 / 360,
    240 / 360,
    270 / 360,
    300 / 360,
  ],
  /** Hue slider ±1 rotates the band by ±HUE_RANGE turns (±30° — one warm
   *  band over, Lightroom's reach). */
  HUE_RANGE: 30 / 360,
  /** Luminance slider ±1 gains the band by ±LUM_EV EV (linear light). */
  LUM_EV: 1.0,
  /** smoothstep edges (on HSV saturation) where hue/luminance fade in —
   *  inflection ~10%, near color equalizer's logistic gate at ~6%. */
  SAT_FEATHER: [0.0, 0.2],
};

/**
 * Color grading (Lightroom-style split toning): per-zone hue/sat tints and
 * luminance gains, weighted by smoothstep masks on sqrt-luma. Mask shape
 * follows darktable's color balance rgb (masked zones) and splittoning
 * (balance shifts the shadow/highlight crossover); the tint itself is a
 * soft-light blend, the standard open-source split-toning operator
 * (e.g. Unity URP color grading).
 */
export const GRADE = {
  /** Center (on sqrt-luma) of the shadows mask falloff. */
  SHADOW_CENTER: 0.35,
  /** Center (on sqrt-luma) of the highlights mask rise. */
  HIGHLIGHT_CENTER: 0.7,
  /** Mask feather half-width at blending 0 → 1. */
  WIDTH: [0.05, 0.45],
  /** Balance slider ±1 shifts both mask centers by ∓BALANCE_SHIFT. */
  BALANCE_SHIFT: 0.3,
  /** Max EV of per-zone luminance gain at slider ±1. */
  LUM_EV: 1.5,
};

/**
 * Presence (texture / clarity / dehaze): the spatial adjustments. The
 * algorithms follow the open-source consensus — texture is à trous (B3
 * spline) wavelet band amplification (darktable's contrast equalizer, ART's
 * texture boost), clarity is wide-radius local contrast with darktable's
 * local-laplacian midtone transfer `d·exp(-d²·k)` (the halo killer), and
 * dehaze is the dark channel prior (He et al. 2009) with a guided-filter
 * refined transmission map (darktable hazeremoval, RawTherapee ipdehaze).
 * Texture/clarity work on gamma-encoded luminance and re-apply as a
 * ratio on linear RGB (vkdt-style, hue-preserving); dehaze works on
 * linear RGB where the haze model holds.
 */
export const SPATIAL = {
  /** Gamma for the luminance working space of texture/clarity. */
  GAMMA: 2.4,
  /** Cap on the linear-light gain texture/clarity may apply (vkdt). */
  RATIO_MAX: 4,
  /** à trous levels: bands 0-2 drive texture, the level-6 residual is the
   *  clarity base (σ ≈ 37 px at preview scale ≈ RT's local contrast). */
  DETAIL_LEVELS: 6,
  /** Number of fine bands the texture slider amplifies. */
  TEXTURE_BANDS: 3,
  /** Texture slider ±1 band gain. */
  TEXTURE_GAIN: 1.5,
  /** Per-band weights: soften the finest band (noise), peak mid (Adobe). */
  TEXTURE_WEIGHTS: [0.5, 1.0, 0.75],
  /** Per-band noise floor (gamma units): boosts only |d| above this. */
  TEXTURE_THRESH: [0.004, 0.002, 0],
  /** Negative texture never attenuates a band below this gain. */
  TEXTURE_MIN_GAIN: 0.2,
  /** Clarity slider ±1 gain on the base-band detail. */
  CLARITY_GAIN: 1.5,
  /** Rolloff k in d·exp(-k·d²): large edges get exponentially less boost
   *  (darktable local laplacian clarity term, σ = 0.5 → k = 6). */
  CLARITY_ROLLOFF: 6,
  /** Haze suppression at slider 1 (the paper's classic ω; < 1 on purpose
   *  so skies keep residual haze). Negative slider re-adds haze. */
  DEHAZE_OMEGA: 0.9,
  /** Transmission floor: caps the 1/t gain so noise can't explode. */
  DEHAZE_T_MIN: 0.05,
  /** Long edge of the downscaled image the dehaze analysis runs on (RT
   *  proves ~200 px suffices; estimation only, the apply is full-res). */
  DEHAZE_MAX_EDGE: 288,
  /** Dark-channel patch min radius, on the analysis grid. */
  DEHAZE_PATCH_RADIUS: 3,
  /** Guided-filter box radius for transmission refinement (≈ 4× patch). */
  DEHAZE_GF_RADIUS: 12,
  /** Guided-filter edge epsilon (on [0,1] luminance). */
  DEHAZE_GF_EPS: 1e-4,
  /** Airlight: average the brightest AIR_QUANTILE of the haziest
   *  AIR_QUANTILE of pixels by dark channel (darktable's 95/95). */
  DEHAZE_AIR_QUANTILE: 0.95,
};

/**
 * Local adjustment masks (Lightroom-style linear/radial gradients). Mask
 * shapes follow darktable: the linear gradient is a smoothstep ramp across
 * a rotated line (masks/gradient.c's sigmoidal falloff), the radial is a
 * rotated ellipse with a quadratic falloff between an inner fully-selected
 * ellipse and the drawn outer one (masks/ellipse.c).
 */
export const MASK = {
  /** Uniform-array bound shared by the shader and the renderer. */
  MAX: 8,
  /** Default linear falloff half-width, as a fraction of the diagonal. */
  LINEAR_RANGE: 0.1,
  /** Default radial feather (Lightroom's default of 50). */
  RADIAL_FEATHER: 0.5,
  /** Default radial semi-axes, as fractions of min(width, height). */
  RADIAL_RADIUS: [0.35, 0.25],
};

/**
 * Transfer curve of the decoded 16-bit data coming out of LibRaw.
 * "linear" assumes gamm:[1,1] is honored; flip to "bt709" if the decode
 * probe shows LibRaw's default BT.709-ish gamma is applied anyway.
 * @type {"linear" | "bt709"}
 */
export const INPUT_TRANSFER = "linear";

/**
 * Display-referred effects applied as a shared post-step on the final
 * sRGB-encoded RGB (after color grading), taking frame-normalized pixel
 * coordinates so the GPU preview and the CPU export land on the identical
 * grid regardless of resolution. Order in the post-step: grain → chromatic
 * noise → invert (invert is always the final operation).
 *
 *   invert — display-referred photo negative, `1 - display` on the
 *     sRGB-encoded value (GIMP "Colors → Invert", the perceptual invert;
 *     "Linear Invert" would un-gamma-correct first and look wrong as a
 *     negative). The toggle is stored as 0/1 for uniform compatibility.
 *
 *   grain — monochromatic LUMINANCE grain with darktable's midtone bias
 *     (its grain module fades the perturbation in shadows and highlights so
 *     the toe and shoulder stay clean), driven by Lightroom's
 *     Amount/Size/Roughness controls. Grain is a deterministic function of
 *     frame-normalized cell coordinates (an integer hash → value noise), so
 *     a downscaled preview and a full-res export show grain of the same
 *     visual size and character — no time, no RNG.
 *
 *   noise (positive half of the bipolar slider) — fine CHROMATIC digital
 *     noise (independent per channel, ~1 cell), the additive side of the
 *     RawTherapee/GIMP "add noise" operators, kept distinct from the mono
 *     grain. The negative half is wavelet-shrinkage denoise and lives in the
 *     presence prepass (see SPATIAL.NR_*), not here.
 */
export const EFFECTS = {
  /** Grain cells across the frame's long edge at Size 0 (Lightroom's
   *  default grain is fairly fine; Size scales this down toward coarser
   *  clumps). darktable scales grain by an ISO-like coarseness; we expose
   *  it as a cell count so preview and export share one normalized grid. */
  GRAIN_GRID_BASE: 900,
  /** Size slider 1 multiplies the cell size by this (fewer, larger cells);
   *  Size −1 divides by it (finer). Geometric so 0 is the neutral middle. */
  GRAIN_GRID_RANGE: 3.0,
  /** Amount 1 perturbs display luma by ±GRAIN_STRENGTH at the midtones
   *  (before the midtone falloff), in sRGB-encoded units. */
  GRAIN_STRENGTH: 0.18,
  /** Roughness 1 routes this fraction of the grain through a second, finer
   *  octave (fractal value noise), making the grain less uniform — the
   *  open-source "roughness/octave mix" knob. */
  GRAIN_ROUGHNESS_MIX: 0.6,
  /** Finer octave's grid multiplier relative to the base grain grid. */
  GRAIN_OCTAVE2: 2.7,
  /** Midtone-bias exponent: weight = (4·y·(1−y))^GRAIN_MIDTONE so grain
   *  peaks at mid display luma and fades to nothing at 0 and 1. */
  GRAIN_MIDTONE: 0.7,
  /** Chromatic noise (positive NOISE slider) cells across the long edge —
   *  near one cell per pixel at preview scale, i.e. very fine. */
  NOISE_GRID: 1400,
  /** NOISE +1 perturbs each display channel by ±NOISE_STRENGTH. */
  NOISE_STRENGTH: 0.12,
};

/**
 * Noise reduction (negative half of the bipolar NOISE slider): edge-
 * preserving soft-threshold (coring) of the finest à trous detail band in
 * the presence prepass, reusing the detail planes spatial.js already
 * computes. Below the noise floor the finest-band detail is shrunk toward
 * zero so flat areas smooth out while edges (large coefficients) survive —
 * the wavelet-shrinkage recipe behind darktable's denoise and RawTherapee's
 * wavelet NR. Distinct from negative Texture, which attenuates whole bands
 * broadband; NR cores only the finest band.
 */
export const NR = {
  /** NOISE −1 soft-threshold on the finest-band detail (gamma-luma units).
   *  Coefficients below this collapse toward zero; above it they keep their
   *  amplitude minus the floor (classic soft threshold). */
  THRESH: 0.05,
};

/** Rec.709 luma weights used for the shadows/highlights masks. */
export const LUMA = [0.2126, 0.7152, 0.0722];
