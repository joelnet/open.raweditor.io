// GLSL for the preview path. The fragment shader mirrors tone-math.js
// step-for-step (presence → white balance → exposure → whites/blacks →
// contrast → highlights/shadows → local masks → vibrance/saturation →
// color grading → sRGB encode); constants are interpolated from
// tone/constants.js so the GPU preview and the CPU export can never drift
// apart. Presence (sharpening/texture/clarity/dehaze) reads per-image aux textures
// from spatial-worker.js and mirrors spatial.js, which the export applies
// as a pre-pass instead. The red mask overlay is the one preview-only
// extra (it never affects an export).

import {
  TONE,
  GRADE,
  HSL,
  SPATIAL,
  MASK,
  EFFECTS,
  NR,
  INPUT_TRANSFER,
  LUMA,
} from "../tone/constants.js";

/** @param {number} n */
const f = (n) => n.toFixed(6);

// Simplex tables (darktable grain.c) interpolated into the GLSL so the
// shader and tone-math.js share one source: perm as ints, grad3 as vec3s,
// per-octave frequencies/amplitudes as floats.
const SIMPLEX_PERM_GLSL = EFFECTS.SIMPLEX_PERM.join(", ");
const SIMPLEX_GRAD3_GLSL = EFFECTS.SIMPLEX_GRAD3.map(
  (g) => `vec3(${g[0].toFixed(1)}, ${g[1].toFixed(1)}, ${g[2].toFixed(1)})`,
).join(", ");
const GRAIN_OCTAVE_F_GLSL = EFFECTS.GRAIN_OCTAVE_F.map(f).join(", ");
const GRAIN_OCTAVE_A_GLSL = EFFECTS.GRAIN_OCTAVE_A.map(f).join(", ");

export const VERTEX_SHADER = `#version 300 es
// Bufferless fullscreen triangle; v_uv y-flipped so texel row 0 (image top)
// lands at the top of the canvas, then windowed by the view rect so zoom
// and crop are a pure UV remap (no geometry or texture changes).
uniform vec2 u_view_offset;  // view rect origin, image UV
uniform vec2 u_view_scale;   // view rect size, image UV
out vec2 v_uv;
void main() {
  vec2 pos = vec2(
    gl_VertexID == 1 ? 3.0 : -1.0,
    gl_VertexID == 2 ? 3.0 : -1.0
  );
  vec2 uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  v_uv = u_view_offset + uv * u_view_scale;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const DECODE_INPUT_GLSL =
  INPUT_TRANSFER === "linear"
    ? `vec3 decodeInput(vec3 v) { return v; }`
    : `vec3 decodeInput(vec3 v) {
  // inverse BT.709 OETF — mirrors decodeInput() in tone-math.js
  bvec3 toe = lessThan(v, vec3(0.081));
  vec3 lo = v / 4.5;
  vec3 hi = pow((v + 0.099) / 1.099, vec3(1.0 / 0.45));
  return mix(hi, lo, vec3(toe));
}`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp usampler2D;
precision highp sampler2DArray;

uniform usampler2D u_image;     // RGBA16UI, linear light
uniform float u_temp;           // [-1, 1]
uniform float u_tint;           // [-1, 1]
uniform float u_exposure;       // EV
uniform float u_contrast;       // [-1, 1]
uniform float u_lightBalance;   // [-1, 1]
uniform float u_highlights;     // [-1, 1]
uniform float u_shadows;        // [-1, 1]
uniform float u_whites;         // [-1, 1]
uniform float u_blacks;         // [-1, 1]
uniform float u_sharpening;     // [0, 1]
uniform float u_texture;        // [-1, 1]
uniform float u_clarity;        // [-1, 1]
uniform float u_dehaze;         // [-1, 1]
uniform float u_vibrance;       // [-1, 1]
uniform float u_saturation;     // [-1, 1]
uniform vec3 u_hsl[${HSL.CENTERS.length}]; // per-band hue, sat, lum, each [-1, 1]
uniform float u_gradeShadowHue; // turns [0, 1)
uniform float u_gradeShadowSat; // [0, 1]
uniform float u_gradeShadowLum; // [-1, 1]
uniform float u_gradeMidHue;    // turns [0, 1)
uniform float u_gradeMidSat;    // [0, 1]
uniform float u_gradeMidLum;    // [-1, 1]
uniform float u_gradeHighHue;   // turns [0, 1)
uniform float u_gradeHighSat;   // [0, 1]
uniform float u_gradeHighLum;   // [-1, 1]
uniform float u_gradeBlending;  // [0, 1]
uniform float u_gradeBalance;   // [-1, 1]

// EFFECTS: display-referred post-step (grain / noise / invert)
uniform float u_invert;         // 0 or 1 (photo negative)
uniform float u_grainAmount;    // [-1, 1] (only the magnitude matters)
uniform float u_grainSize;      // [-1, 1] (coarseness)
uniform float u_grainMidtones;  // [0, 1] — darktable midtones bias (×100)
uniform float u_noise;          // [-1, 1] — positive adds chromatic noise

// Spatial aux, computed per image by spatial-worker.js (slider moves stay
// single-pass): à trous detail planes of the source gamma-luma, the
// Richardson-Lucy linear-luma delta, the guided-filter-refined haze amount,
// and Light Balance's guided tonal weight. u_hasAux gates until ready.
uniform int u_hasAux;
uniform sampler2D u_detail;     // c1, c2, c3, base (clarity residual)
uniform sampler2D u_sharpenD;   // Richardson-Lucy linear-luma delta
uniform sampler2D u_dehazeD;    // refined dark channel [0, 1]
uniform sampler2D u_lightBalanceW; // guided tonal weight [0.25, 1]
uniform vec3 u_airlight;

// Geometry: orientation (quarter-turns CW) + straighten rotation. v_uv is
// frame UV (the oriented image); frameToSourceUv mirrors frameToSource()
// in tone/geometry.js.
uniform int u_orient;           // 0–3
uniform ivec2 u_flip;           // mirror frame x / y (0 or 1 each)
uniform vec2 u_rot;             // cos, sin of the straighten angle
uniform float u_coverScale;     // ≥ 1, keeps the frame free of blank corners
uniform vec2 u_frame;           // frame size in px (oriented preview dims)

// Local masks — geometry and adjustments mirror tone/mask-math.js.
uniform int u_maskCount;
uniform vec4 u_maskGeo[${MASK.MAX}];   // x, y (UV), angle (rad), type (0 linear, 1 radial, 2 brush)
uniform vec4 u_maskParam[${MASK.MAX}]; // linear: range,-,-,invert | radial: rx, ry, feather, invert | brush: -, layer, -, invert
uniform vec4 u_maskAdjA[${MASK.MAX}];  // temp, tint, exposure, contrast
uniform vec4 u_maskAdjB[${MASK.MAX}];  // highlights, shadows, whites, blacks
uniform vec4 u_maskAdjC[${MASK.MAX}];  // vibrance, saturation, -, -
uniform vec4 u_maskAdjD[${MASK.MAX}];  // sharpening, texture, clarity, dehaze
uniform int u_maskOverlay;             // mask index to tint red, -1 = off
// Brush (drawn) mask coverage: one R8 layer per brush-mask slot, LINEAR
// filtered so the bilinear fetch matches sampleCoverage() in mask-math.js.
// param.y of a brush mask selects the layer. Bound on texture unit 4.
uniform highp sampler2DArray u_brushMask;

in vec2 v_uv;
out vec4 outColor;

${DECODE_INPUT_GLSL}

vec3 srgbEncode(vec3 c) {
  bvec3 lo = lessThanEqual(c, vec3(0.0031308));
  vec3 a = c * 12.92;
  vec3 b = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(b, a, vec3(lo));
}

vec3 srgbDecode(vec3 c) {
  bvec3 lo = lessThanEqual(c, vec3(0.04045));
  vec3 a = c / 12.92;
  vec3 b = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(b, a, vec3(lo));
}

// pure wheel hue → RGB — mirrors hueColor() in tone-math.js
vec3 hueColor(float h) {
  float t = fract(h);
  return clamp(vec3(
    abs(6.0 * t - 3.0) - 1.0,
    2.0 - abs(6.0 * t - 2.0),
    2.0 - abs(6.0 * t - 4.0)
  ), 0.0, 1.0);
}

// pegtop soft light: identity at blend 0.5, pins black and white
vec3 softLight(vec3 a, vec3 b) {
  return (1.0 - 2.0 * b) * a * a + 2.0 * b * a;
}

// --- shared display-referred effects (grain / noise / invert) -----------
// Mirrors applyDisplayEffects() + hash31()/valueNoise() in tone-math.js,
// bit-for-bit: uint arithmetic, frame-normalized coordinates. Keyed off
// v_uv * u_frame so the downscaled preview and the full-res export show
// grain/noise of the same visual size.

// integer hash → [0, 1) — mirrors hash31() in tone-math.js (uint mixing)
float hash31(uint x, uint y, uint salt) {
  uint h = x ^ (y * 0x9e3779b1u);
  h = h ^ (salt * 0x85ebca77u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return float(h) / 4294967296.0;
}

// value-noise interpolant — mirrors fade() in tone-math.js
float grainFade(float t) {
  float u = clamp(t, 0.0, 1.0);
  return u * u * (3.0 - 2.0 * u);
}

// bilinear value noise in [-1, 1) — mirrors valueNoise() in tone-math.js
float valueNoise(float u, float v, float grid, uint salt) {
  float gx = u * grid;
  float gy = v * grid;
  float x0 = floor(gx);
  float y0 = floor(gy);
  float fx = grainFade(gx - x0);
  float fy = grainFade(gy - y0);
  uint ix = uint(int(x0));
  uint iy = uint(int(y0));
  float c00 = hash31(ix, iy, salt);
  float c10 = hash31(ix + 1u, iy, salt);
  float c01 = hash31(ix, iy + 1u, salt);
  float c11 = hash31(ix + 1u, iy + 1u, salt);
  float top = c00 + (c10 - c00) * fx;
  float bot = c01 + (c11 - c01) * fx;
  return (top + (bot - top) * fy) * 2.0 - 1.0;
}

// darktable grain.c: 3D simplex noise (canonical Perlin tables) + the
// photographic paper-response curve. Mirrors simplexNoise()/simplex2dNoise()/
// paperResp()/paperRespInverse() in tone-math.js, line for line. The
// 256-entry permutation is indexed with & 255 (the doubled 512 table reduces
// to this: perm512[n] == perm[n & 255]).
const int simplexPerm[256] = int[256](${SIMPLEX_PERM_GLSL});
const vec3 simplexGrad3[12] = vec3[12](${SIMPLEX_GRAD3_GLSL});

float simplexNoise(float xin, float yin, float zin) {
  float F3 = ${f(EFFECTS.SIMPLEX_F3)};
  float G3 = ${f(EFFECTS.SIMPLEX_G3)};
  float s = (xin + yin + zin) * F3;
  int i = int(floor(xin + s));
  int j = int(floor(yin + s));
  int k = int(floor(zin + s));
  float t = float(i + j + k) * G3;
  float x0 = xin - (float(i) - t);
  float y0 = yin - (float(j) - t);
  float z0 = zin - (float(k) - t);
  int i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  float x1 = x0 - float(i1) + G3, y1 = y0 - float(j1) + G3, z1 = z0 - float(k1) + G3;
  float x2 = x0 - float(i2) + 2.0 * G3, y2 = y0 - float(j2) + 2.0 * G3, z2 = z0 - float(k2) + 2.0 * G3;
  float x3 = x0 - 1.0 + 3.0 * G3, y3 = y0 - 1.0 + 3.0 * G3, z3 = z0 - 1.0 + 3.0 * G3;
  int ii = i & 255, jj = j & 255, kk = k & 255;
  int gi0 = simplexPerm[(ii + simplexPerm[(jj + simplexPerm[kk]) & 255]) & 255] % 12;
  int gi1 = simplexPerm[(ii + i1 + simplexPerm[(jj + j1 + simplexPerm[(kk + k1) & 255]) & 255]) & 255] % 12;
  int gi2 = simplexPerm[(ii + i2 + simplexPerm[(jj + j2 + simplexPerm[(kk + k2) & 255]) & 255]) & 255] % 12;
  int gi3 = simplexPerm[(ii + 1 + simplexPerm[(jj + 1 + simplexPerm[(kk + 1) & 255]) & 255]) & 255] % 12;
  float n0 = 0.0, n1 = 0.0, n2 = 0.0, n3 = 0.0;
  float t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0.0) { t0 *= t0; n0 = t0 * t0 * dot(simplexGrad3[gi0], vec3(x0, y0, z0)); }
  float t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0.0) { t1 *= t1; n1 = t1 * t1 * dot(simplexGrad3[gi1], vec3(x1, y1, z1)); }
  float t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0.0) { t2 *= t2; n2 = t2 * t2 * dot(simplexGrad3[gi2], vec3(x2, y2, z2)); }
  float t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0.0) { t3 *= t3; n3 = t3 * t3 * dot(simplexGrad3[gi3], vec3(x3, y3, z3)); }
  return 32.0 * (n0 + n1 + n2 + n3);
}

float simplex2dNoise(float x, float y, float zoom) {
  float fF[3] = float[3](${GRAIN_OCTAVE_F_GLSL});
  float fA[3] = float[3](${GRAIN_OCTAVE_A_GLSL});
  float total = 0.0;
  for (int o = 0; o < 3; o++) {
    total += simplexNoise(x * fF[o] / zoom, y * fF[o] / zoom, float(o)) * fA[o];
  }
  return total;
}

float paperResp(float exposure, float mb, float gp) {
  float delta = ${f(EFFECTS.GRAIN_LUT_DELTA_MAX)}
    * exp((mb / 100.0) * log(${f(EFFECTS.GRAIN_LUT_DELTA_MIN)}));
  return (1.0 + 2.0 * delta)
    / (1.0 + exp((4.0 * gp * (0.5 - exposure)) / (1.0 + 2.0 * delta))) - delta;
}

float paperRespInverse(float density, float mb, float gp) {
  float delta = ${f(EFFECTS.GRAIN_LUT_DELTA_MAX)}
    * exp((mb / 100.0) * log(${f(EFFECTS.GRAIN_LUT_DELTA_MIN)}));
  return (-log((1.0 + 2.0 * delta) / (density + delta) - 1.0) * (1.0 + 2.0 * delta))
    / (4.0 * gp) + 0.5;
}

// grain + chromatic noise + photo-negative invert on display RGB —
// mirrors applyDisplayEffects() in tone-math.js. (u, v) are frame-
// normalized; fw, fh size the frame for the square-cell aspect fix.
vec3 applyDisplayEffects(vec3 rgb, vec2 uv, float fw, float fh) {
  float aspect = fh > 0.0 ? fh / fw : 1.0;
  float vv = uv.y * aspect;

  if (u_grainAmount > 0.0) {
    float minWH = max(min(fw, fh), 1.0);
    float gx = uv.x * fw / minWH;
    float gy = uv.y * fh / minWH;
    float iso = ${f(EFFECTS.GRAIN_ISO_BASE)}
      * pow(${f(EFFECTS.GRAIN_ISO_OCTAVE)}, u_grainSize);
    float zoom = (1.0 + 8.0 * (iso / ${f(EFFECTS.GRAIN_SCALE_FACTOR)}) / 100.0)
      / 800.0;
    float gnoise = simplex2dNoise(gx, gy, zoom);
    float gu = clamp(gnoise * u_grainAmount
      * ${f(EFFECTS.GRAIN_LIGHTNESS_STRENGTH_SCALE)}, -0.5, 0.5);
    float mb = u_grainMidtones * 100.0;
    float gp = ${f(EFFECTS.GRAIN_PAPER_GAMMA)};
    float l = clamp(dot(rgb, vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])})),
      0.0, 1.0);
    float d = paperResp(gu + paperRespInverse(l, mb, gp), mb, gp) - l;
    rgb += vec3(d);
  }

  if (u_noise > 0.0) {
    float grid = ${f(EFFECTS.NOISE_GRID)};
    float amp = u_noise * ${f(EFFECTS.NOISE_STRENGTH)};
    rgb += vec3(
      valueNoise(uv.x, vv, grid, 2u),
      valueNoise(uv.x, vv, grid, 3u),
      valueNoise(uv.x, vv, grid, 4u)
    ) * amp;
  }

  rgb = clamp(rgb, 0.0, 1.0);
  if (u_invert > 0.5) rgb = vec3(1.0) - rgb;
  return rgb;
}

// color mixer band centers in hue turns — mirrors HSL.CENTERS
const float HSL_CENTERS[${HSL.CENTERS.length}] = float[${HSL.CENTERS.length}](
  ${HSL.CENTERS.map(f).join(", ")}
);

// One à trous band's texture boost — mirrors textureDelta() in spatial.js.
// Positive: amplify what exceeds the band's noise floor; negative:
// attenuate the band, floored so edges never fully dissolve.
float textureDelta(float d, float w, float tau, float s) {
  if (s >= 0.0) {
    return s * ${f(SPATIAL.TEXTURE_GAIN)} * w
      * sign(d) * max(abs(d) - tau, 0.0);
  }
  return (max(1.0 + s * w, ${f(SPATIAL.TEXTURE_MIN_GAIN)}) - 1.0) * d;
}

// Finest-band soft-threshold coring for denoise — mirrors nrDelta() in
// spatial.js. Returns shrink(d1) − d1 scaled by amount (the magnitude of a
// negative NOISE slider); flats below the floor smooth, edges survive.
float nrDelta(float d1, float amount) {
  if (amount <= 0.0) return 0.0;
  float a = abs(d1);
  float shrunk = a <= ${f(NR.THRESH)} ? 0.0 : sign(d1) * (a - ${f(NR.THRESH)});
  return amount * (shrunk - d1);
}

// Mask weight at one pixel — mirrors maskWeight() in mask-math.js.
// Computed in pixel space so radial masks stay true ellipses on
// non-square images.
float maskWeight(vec2 uv, vec2 size, vec4 geo, vec4 param) {
  float m;
  if (geo.w > 1.5) {
    // brush: raster coverage, LINEAR-sampled at the pixel's frame UV —
    // mirrors sampleCoverage() in mask-math.js. param.y holds the layer.
    m = texture(u_brushMask, vec3(uv, param.y)).r;
    return mix(m, 1.0 - m, param.w);
  }
  vec2 d = uv * size - geo.xy * size;
  float ca = cos(geo.z), sa = sin(geo.z);
  if (geo.w < 0.5) {
    // linear: signed distance along the gradient direction,
    // diagonal-normalized, smoothstep ramp (≈ darktable's erf sigmoid)
    float t = (ca * d.x + sa * d.y) / length(size);
    float range = max(param.x, 1e-4);
    m = smoothstep(-range, range, t);
  } else {
    // rotated ellipse: quadratic falloff in squared-radius space between
    // the inner (fully selected) and outer ellipse, per darktable
    float mind = min(size.x, size.y);
    float a = max(param.x, 1e-3) * mind;
    float b = max(param.y, 1e-3) * mind;
    float ia = a * (1.0 - param.z);
    float ib = b * (1.0 - param.z);
    float l2 = dot(d, d);
    if (l2 < 1e-6) {
      m = 1.0;
    } else {
      vec2 u = d * inversesqrt(l2);
      float cv = u.x * ca + u.y * sa;
      float sv = -u.x * sa + u.y * ca;
      float t2 = (a * a * b * b) / (a * a * sv * sv + b * b * cv * cv);
      float r2 = (ia * ia * ib * ib)
        / max(ia * ia * sv * sv + ib * ib * cv * cv, 1e-9);
      float f = clamp((t2 - l2) / max(t2 - r2, 1e-9), 0.0, 1.0);
      m = f * f;
    }
  }
  return mix(m, 1.0 - m, param.w);
}

// One mask's local adjustments, every strength scaled by the mask weight
// m — mirrors applyMaskAdjust() in tone-math.js (same ops and order as
// global steps 1–6; vibrance/saturation runs unclamped here, the global
// clamp happens later at step 6).
vec3 applyMaskAdjust(vec3 rgb, float m, vec4 adjA, vec4 adjB, vec4 adjC) {
  // 1. white balance
  rgb *= exp2(vec3(
    ${f(TONE.WB_TEMP_EV)} * adjA.x,
    -${f(TONE.WB_TINT_EV)} * adjA.y,
    -${f(TONE.WB_TEMP_EV)} * adjA.x
  ) * m);

  // 2. exposure
  rgb *= exp2(adjA.z * m);

  // 3. whites / blacks
  float white = 1.0 - ${f(TONE.WHITES_RANGE)} * adjB.z * m;
  float black = -${f(TONE.BLACKS_RANGE)} * adjB.w * m;
  rgb = (rgb - black) / max(white - black, 1e-4);

  // 4. contrast
  rgb = max(rgb, vec3(0.0));
  float cc = adjA.w * m;
  if (cc != 0.0) {
    float c = cc >= 0.0 ? 1.0 + cc : 1.0 / (1.0 - cc);
    rgb = ${f(TONE.PIVOT)} * pow(rgb / ${f(TONE.PIVOT)}, vec3(c));
  }

  // 5. highlights / shadows
  if (adjB.x != 0.0 || adjB.y != 0.0) {
    float y = dot(rgb, vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])}));
    float ye = sqrt(clamp(y, 0.0, 1.0));
    float mS = 1.0 - smoothstep(${f(TONE.SHADOW_MASK[0])}, ${f(TONE.SHADOW_MASK[1])}, ye);
    float mH = smoothstep(${f(TONE.HIGHLIGHT_MASK[0])}, ${f(TONE.HIGHLIGHT_MASK[1])}, ye);
    rgb *= exp2(${f(TONE.SH_STRENGTH_EV)} * (adjB.y * mS + adjB.x * mH) * m);
  }

  // 6. vibrance / saturation
  if (adjC.x != 0.0 || adjC.y != 0.0) {
    float y = dot(rgb, vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])}));
    float mx = max(rgb.r, max(rgb.g, rgb.b));
    float mn = min(rgb.r, min(rgb.g, rgb.b));
    float sat = mx > 0.0 ? (mx - mn) / mx : 0.0;
    float w = adjC.x >= 0.0 ? 1.0 - sat : sat;
    float factor = max((1.0 + adjC.y * m) * (1.0 + adjC.x * m * w), 0.0);
    rgb = vec3(y) + (rgb - vec3(y)) * factor;
  }

  return rgb;
}

vec3 applyMaskPresence(vec3 rgb, float ySrc, ivec2 p, float m, vec4 adjD) {
  float dehaze = adjD.w * m;
  if (dehaze != 0.0) {
    float D = texelFetch(u_dehazeD, p, 0).r;
    float t = max(1.0 - ${f(SPATIAL.DEHAZE_OMEGA)} * dehaze * D,
      ${f(SPATIAL.DEHAZE_T_MIN)});
    rgb = max((rgb - u_airlight) / t + u_airlight, 0.0);
  }

  float sharpening = adjD.x * m;
  if (sharpening > 0.0) {
    float delta = texelFetch(u_sharpenD, p, 0).r;
    float yNew = max(ySrc + sharpening * delta, 0.0);
    rgb *= clamp(yNew / max(ySrc, 1e-5), 0.0, ${f(SPATIAL.RATIO_MAX)});
  }

  float texture = adjD.y * m;
  float clarity = adjD.z * m;
  if (texture != 0.0 || clarity != 0.0) {
    float y0 = pow(max(ySrc, 0.0), 1.0 / ${f(SPATIAL.GAMMA)});
    vec4 c = texelFetch(u_detail, p, 0);
    float delta = 0.0;
    if (texture != 0.0) {
      delta += textureDelta(y0 - c.x,
        ${f(SPATIAL.TEXTURE_WEIGHTS[0])}, ${f(SPATIAL.TEXTURE_THRESH[0])}, texture);
      delta += textureDelta(c.x - c.y,
        ${f(SPATIAL.TEXTURE_WEIGHTS[1])}, ${f(SPATIAL.TEXTURE_THRESH[1])}, texture);
      delta += textureDelta(c.y - c.z,
        ${f(SPATIAL.TEXTURE_WEIGHTS[2])}, ${f(SPATIAL.TEXTURE_THRESH[2])}, texture);
    }
    if (clarity != 0.0) {
      float d = y0 - c.w;
      float mid = clamp(4.0 * y0 * (1.0 - y0), 0.0, 1.0);
      delta += clarity * ${f(SPATIAL.CLARITY_GAIN)} * mid * d
        * exp(-${f(SPATIAL.CLARITY_ROLLOFF)} * d * d);
    }
    float yNew = max(y0 + delta, 0.0);
    rgb *= clamp(pow(yNew, ${f(SPATIAL.GAMMA)}) / max(ySrc, 1e-5),
      0.0, ${f(SPATIAL.RATIO_MAX)});
  }

  return rgb;
}

vec2 frameToSourceUv(vec2 uv) {
  // flip first, in frame UV (mirrors frameToSource in tone/geometry.js:
  // f.x → 1 - f.x, f.y → 1 - f.y) so it composes the same way under the
  // 90° turns and straighten that follow
  if (u_flip.x == 1) uv.x = 1.0 - uv.x;
  if (u_flip.y == 1) uv.y = 1.0 - uv.y;
  vec2 p = (uv - 0.5) * u_frame;
  // inverse of the on-screen CW rotation (y-down coordinates)
  p = vec2(u_rot.x * p.x + u_rot.y * p.y, -u_rot.y * p.x + u_rot.x * p.y)
    / u_coverScale;
  vec2 f = p / u_frame + 0.5;
  if (u_orient == 1) return vec2(f.y, 1.0 - f.x);
  if (u_orient == 2) return vec2(1.0 - f.x, 1.0 - f.y);
  if (u_orient == 3) return vec2(1.0 - f.y, f.x);
  return f;
}

void main() {
  ivec2 ts = textureSize(u_image, 0);
  vec2 suv = frameToSourceUv(v_uv);
  ivec2 p = clamp(ivec2(suv * vec2(ts)), ivec2(0), ts - 1);
  vec3 rgb = decodeInput(vec3(texelFetch(u_image, p, 0).rgb) / 65535.0);

  // 0. presence: dehaze (linear RGB, where the haze model holds), then
  // texture/clarity (gamma-luma delta applied as a hue-preserving linear
  // ratio) — mirrors applyPresencePrepass() in spatial.js: same formulas,
  // same position (source-referred, before white balance).
  if (u_hasAux == 1) {
    float ySrc = dot(rgb, vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])}));
    if (u_dehaze != 0.0) {
      float D = texelFetch(u_dehazeD, p, 0).r;
      float t = max(1.0 - ${f(SPATIAL.DEHAZE_OMEGA)} * u_dehaze * D,
        ${f(SPATIAL.DEHAZE_T_MIN)});
      rgb = max((rgb - u_airlight) / t + u_airlight, 0.0);
    }
    if (u_sharpening > 0.0) {
      float delta = texelFetch(u_sharpenD, p, 0).r;
      float yNew = max(ySrc + u_sharpening * delta, 0.0);
      rgb *= clamp(yNew / max(ySrc, 1e-5), 0.0, ${f(SPATIAL.RATIO_MAX)});
    }
    float nr = max(-u_noise, 0.0);
    if (u_texture != 0.0 || u_clarity != 0.0 || nr > 0.0) {
      float y0 = pow(max(ySrc, 0.0), 1.0 / ${f(SPATIAL.GAMMA)});
      vec4 c = texelFetch(u_detail, p, 0);
      float delta = 0.0;
      // denoise: soft-threshold the finest band (y0 − c1) only
      if (nr > 0.0) delta += nrDelta(y0 - c.x, nr);
      if (u_texture != 0.0) {
        delta += textureDelta(y0 - c.x,
          ${f(SPATIAL.TEXTURE_WEIGHTS[0])}, ${f(SPATIAL.TEXTURE_THRESH[0])}, u_texture);
        delta += textureDelta(c.x - c.y,
          ${f(SPATIAL.TEXTURE_WEIGHTS[1])}, ${f(SPATIAL.TEXTURE_THRESH[1])}, u_texture);
        delta += textureDelta(c.y - c.z,
          ${f(SPATIAL.TEXTURE_WEIGHTS[2])}, ${f(SPATIAL.TEXTURE_THRESH[2])}, u_texture);
      }
      if (u_clarity != 0.0) {
        // clarityDelta(): exp rolloff starves large edges (halos), the
        // midtone parabola keeps the endpoints from clipping
        float d = y0 - c.w;
        float mid = clamp(4.0 * y0 * (1.0 - y0), 0.0, 1.0);
        delta += u_clarity * ${f(SPATIAL.CLARITY_GAIN)} * mid * d
          * exp(-${f(SPATIAL.CLARITY_ROLLOFF)} * d * d);
      }
      float yNew = max(y0 + delta, 0.0);
      rgb *= clamp(pow(yNew, ${f(SPATIAL.GAMMA)}) / max(ySrc, 1e-5),
        0.0, ${f(SPATIAL.RATIO_MAX)});
    }
    for (int i = 0; i < ${MASK.MAX}; i++) {
      if (i >= u_maskCount) break;
      float mw = maskWeight(v_uv, u_frame, u_maskGeo[i], u_maskParam[i]);
      if (mw > 0.0) {
        rgb = applyMaskPresence(rgb, ySrc, p, mw, u_maskAdjD[i]);
      }
    }
    if (u_lightBalance != 0.0) {
      float lbw = texelFetch(u_lightBalanceW, p, 0).r;
      float gain = clamp(
        1.0 + ${f(TONE.LIGHT_BALANCE_STRENGTH)} * u_lightBalance * lbw,
        ${f(TONE.LIGHT_BALANCE_GAIN_RANGE[0])},
        ${f(TONE.LIGHT_BALANCE_GAIN_RANGE[1])}
      );
      rgb *= gain;
    }
  }

  // 1. white balance: +temp warms (red up, blue down), +tint goes magenta
  rgb *= exp2(vec3(
    ${f(TONE.WB_TEMP_EV)} * u_temp,
    -${f(TONE.WB_TINT_EV)} * u_tint,
    -${f(TONE.WB_TEMP_EV)} * u_temp
  ));

  // 2. exposure
  rgb *= exp2(u_exposure);

  // 3. whites / blacks: levels remap (+whites brightens, +blacks lifts)
  float white = 1.0 - ${f(TONE.WHITES_RANGE)} * u_whites;
  float black = -${f(TONE.BLACKS_RANGE)} * u_blacks;
  rgb = (rgb - black) / max(white - black, 1e-4);

  // 4. contrast: power curve pivoting on middle gray
  rgb = max(rgb, vec3(0.0));
  if (u_contrast != 0.0) {
    float c = u_contrast >= 0.0 ? 1.0 + u_contrast : 1.0 / (1.0 - u_contrast);
    rgb = ${f(TONE.PIVOT)} * pow(rgb / ${f(TONE.PIVOT)}, vec3(c));
  }

  // 5. highlights / shadows: luminance-masked exposure gain
  float y = dot(rgb, vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])}));
  float ye = sqrt(clamp(y, 0.0, 1.0));
  float mS = 1.0 - smoothstep(${f(TONE.SHADOW_MASK[0])}, ${f(TONE.SHADOW_MASK[1])}, ye);
  float mH = smoothstep(${f(TONE.HIGHLIGHT_MASK[0])}, ${f(TONE.HIGHLIGHT_MASK[1])}, ye);
  rgb *= exp2(${f(TONE.SH_STRENGTH_EV)} * (u_shadows * mS + u_highlights * mH));

  // 5.5 local masks: each mask's own adjustment set, applied through its
  // per-pixel weight (locals stack on the globals)
  for (int i = 0; i < ${MASK.MAX}; i++) {
    if (i >= u_maskCount) break;
    float mw = maskWeight(v_uv, u_frame, u_maskGeo[i], u_maskParam[i]);
    if (mw > 0.0) {
      rgb = applyMaskAdjust(rgb, mw, u_maskAdjA[i], u_maskAdjB[i], u_maskAdjC[i]);
    }
  }

  // 6. vibrance / saturation: scale chroma around Rec.709 luma. Vibrance is
  // weighted by 1 - HSV saturation so already-vivid pixels are protected
  // (darktable velvia-style); negative vibrance tames the most saturated
  // colors first.
  rgb = clamp(rgb, 0.0, 1.0);
  if (u_vibrance != 0.0 || u_saturation != 0.0) {
    y = dot(rgb, vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])}));
    float mx = max(rgb.r, max(rgb.g, rgb.b));
    float mn = min(rgb.r, min(rgb.g, rgb.b));
    float sat = mx > 0.0 ? (mx - mn) / mx : 0.0;
    float w = u_vibrance >= 0.0 ? 1.0 - sat : sat;
    float factor = max((1.0 + u_saturation) * (1.0 + u_vibrance * w), 0.0);
    rgb = vec3(y) + (rgb - vec3(y)) * factor;
  }

  // 6.5 HSL color mixer: per-hue-band hue rotation, saturation scale, and
  // luminance gain, in HSV over the display-referred (sRGB-encoded) values
  // — hue computed on linear RGB would disagree with the colors users see
  // (RawTherapee's HSV equalizer encodes for the same reason). A pixel's
  // hue selects its two adjacent bands; their adjustments crossfade with a
  // smoothstep (weights always sum to 1 — no gaps, no banding) and apply
  // once. Hue and luminance are gated by saturation so neutral pixels,
  // whose hue is noise, never move; the sat gain self-gates (× sat).
  bool mixing = false;
  for (int i = 0; i < ${HSL.CENTERS.length}; i++) {
    if (u_hsl[i] != vec3(0.0)) { mixing = true; break; }
  }
  if (mixing) {
    vec3 e = srgbEncode(clamp(rgb, 0.0, 1.0));
    float mx = max(e.r, max(e.g, e.b));
    float mn = min(e.r, min(e.g, e.b));
    float ch = mx - mn;
    if (ch > 1e-9) {
      float h;
      if (mx == e.r) h = (e.g - e.b) / ch / 6.0;
      else if (mx == e.g) h = (2.0 + (e.b - e.r) / ch) / 6.0;
      else h = (4.0 + (e.r - e.g) / ch) / 6.0;
      if (h < 0.0) h += 1.0;
      float sat = ch / mx;
      // red's center sits at hue 0, so every h lands in exactly one
      // segment [center_i, center_i+1) with the last wrapping back to red
      int seg = ${HSL.CENTERS.length - 1};
      for (int k = 0; k + 1 < ${HSL.CENTERS.length}; k++) {
        if (h < HSL_CENTERS[k + 1]) { seg = k; break; }
      }
      float c1 = seg + 1 < ${HSL.CENTERS.length} ? HSL_CENTERS[seg + 1] : 1.0;
      float t = smoothstep(HSL_CENTERS[seg], c1, h);
      vec3 adj = mix(u_hsl[seg], u_hsl[(seg + 1) % ${HSL.CENTERS.length}], t);
      float aw = smoothstep(${f(HSL.SAT_FEATHER[0])}, ${f(HSL.SAT_FEATHER[1])}, sat);
      float dH = adj.x * ${f(HSL.HUE_RANGE)} * aw;
      float s2 = clamp(sat * (1.0 + adj.y), 0.0, 1.0);
      rgb = min(srgbDecode(mx * (vec3(1.0) + (hueColor(h + dH) - 1.0) * s2))
        * exp2(${f(HSL.LUM_EV)} * adj.z * aw), 1.0);
    } else {
      rgb = clamp(rgb, 0.0, 1.0);
    }
  }

  // 7. color grading: per-zone luminance gain (linear light), then per-zone
  // soft-light tint on the display-referred values. Masks are computed once,
  // before the luminance gain moves the pixel.
  bool grading = u_gradeShadowSat != 0.0 || u_gradeMidSat != 0.0
    || u_gradeHighSat != 0.0 || u_gradeShadowLum != 0.0
    || u_gradeMidLum != 0.0 || u_gradeHighLum != 0.0;
  vec3 display;
  if (grading) {
    y = dot(rgb, vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])}));
    ye = sqrt(clamp(y, 0.0, 1.0));
    float wid = mix(${f(GRADE.WIDTH[0])}, ${f(GRADE.WIDTH[1])}, u_gradeBlending);
    float shift = ${f(GRADE.BALANCE_SHIFT)} * u_gradeBalance;
    float sC = ${f(GRADE.SHADOW_CENTER)} - shift;
    float hC = ${f(GRADE.HIGHLIGHT_CENTER)} - shift;
    float wS = 1.0 - smoothstep(sC - wid, sC + wid, ye);
    float wH = smoothstep(hC - wid, hC + wid, ye);
    float wM = (1.0 - wS) * (1.0 - wH);
    rgb *= exp2(${f(GRADE.LUM_EV)} * (u_gradeShadowLum * wS
      + u_gradeMidLum * wM + u_gradeHighLum * wH));
    vec3 e = srgbEncode(clamp(rgb, 0.0, 1.0));
    e = softLight(e, mix(vec3(0.5), hueColor(u_gradeShadowHue), u_gradeShadowSat * wS));
    e = softLight(e, mix(vec3(0.5), hueColor(u_gradeMidHue), u_gradeMidSat * wM));
    e = softLight(e, mix(vec3(0.5), hueColor(u_gradeHighHue), u_gradeHighSat * wH));
    display = clamp(e, 0.0, 1.0);
  } else {
    // 8. clamp + display encode
    display = srgbEncode(clamp(rgb, 0.0, 1.0));
  }

  // EFFECTS: grain / chromatic noise / photo-negative invert on the final
  // display-referred RGB — inlined identically to the post-step in
  // toneMapRows (tone-math.js), keyed off frame-normalized coords so the
  // preview and the export agree at any resolution.
  display = applyDisplayEffects(display, v_uv, u_frame.x, u_frame.y);

  // mask visualization: tint the selected mask's coverage red
  // (preview-only — the CPU export has no counterpart on purpose)
  if (u_maskOverlay >= 0 && u_maskOverlay < u_maskCount) {
    float ov = maskWeight(v_uv, u_frame,
      u_maskGeo[u_maskOverlay], u_maskParam[u_maskOverlay]);
    display = mix(display, vec3(0.86, 0.15, 0.15), ov * 0.55);
  }

  outColor = vec4(display, 1.0);
}
`;
