// GLSL for the preview path. The fragment shader mirrors tone-math.js
// step-for-step (presence → white balance → exposure → whites/blacks →
// contrast → highlights/shadows → local masks → vibrance/saturation →
// color grading → sRGB encode); constants are interpolated from
// tone/constants.js so the GPU preview and the CPU export can never drift
// apart. Presence (texture/clarity/dehaze) reads per-image aux textures
// from spatial-worker.js and mirrors spatial.js, which the export applies
// as a pre-pass instead. The red mask overlay is the one preview-only
// extra (it never affects an export).

import {
  TONE,
  GRADE,
  HSL,
  SPATIAL,
  MASK,
  INPUT_TRANSFER,
  LUMA,
} from "../tone/constants.js";

/** @param {number} n */
const f = (n) => n.toFixed(6);

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

uniform usampler2D u_image;     // RGBA16UI, linear light
uniform float u_temp;           // [-1, 1]
uniform float u_tint;           // [-1, 1]
uniform float u_exposure;       // EV
uniform float u_contrast;       // [-1, 1]
uniform float u_highlights;     // [-1, 1]
uniform float u_shadows;        // [-1, 1]
uniform float u_whites;         // [-1, 1]
uniform float u_blacks;         // [-1, 1]
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

// Presence aux, computed per image by spatial-worker.js (slider moves stay
// single-pass): à trous detail planes of the source gamma-luma and the
// guided-filter-refined haze amount. u_hasAux gates until they're ready.
uniform int u_hasAux;
uniform sampler2D u_detail;     // c1, c2, c3, base (clarity residual)
uniform sampler2D u_dehazeD;    // refined dark channel [0, 1]
uniform vec3 u_airlight;

// Geometry: orientation (quarter-turns CW) + straighten rotation. v_uv is
// frame UV (the oriented image); frameToSourceUv mirrors frameToSource()
// in tone/geometry.js.
uniform int u_orient;           // 0–3
uniform vec2 u_rot;             // cos, sin of the straighten angle
uniform float u_coverScale;     // ≥ 1, keeps the frame free of blank corners
uniform vec2 u_frame;           // frame size in px (oriented preview dims)

// Local masks — geometry and adjustments mirror tone/mask-math.js.
uniform int u_maskCount;
uniform vec4 u_maskGeo[${MASK.MAX}];   // x, y (UV), angle (rad), type (0 linear, 1 radial)
uniform vec4 u_maskParam[${MASK.MAX}]; // linear: range,-,-,invert | radial: rx, ry, feather, invert
uniform vec4 u_maskAdjA[${MASK.MAX}];  // temp, tint, exposure, contrast
uniform vec4 u_maskAdjB[${MASK.MAX}];  // highlights, shadows, whites, blacks
uniform vec4 u_maskAdjC[${MASK.MAX}];  // vibrance, saturation, -, -
uniform int u_maskOverlay;             // mask index to tint red, -1 = off

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

// color mixer band centers in hue turns — mirrors HSL.CENTERS
const float HSL_CENTERS[${HSL.CENTERS.length}] = float[${HSL.CENTERS.length}](
  ${HSL.CENTERS.map(f).join(", ")}
);

// One à trous band's texture boost — mirrors textureDelta() in spatial.js.
// Positive: amplify what exceeds the band's noise floor; negative:
// attenuate the band, floored so edges never fully dissolve.
float textureDelta(float d, float w, float tau) {
  if (u_texture >= 0.0) {
    return u_texture * ${f(SPATIAL.TEXTURE_GAIN)} * w
      * sign(d) * max(abs(d) - tau, 0.0);
  }
  return (max(1.0 + u_texture * w, ${f(SPATIAL.TEXTURE_MIN_GAIN)}) - 1.0) * d;
}

// Mask weight at one pixel — mirrors maskWeight() in mask-math.js.
// Computed in pixel space so radial masks stay true ellipses on
// non-square images.
float maskWeight(vec2 uv, vec2 size, vec4 geo, vec4 param) {
  vec2 d = uv * size - geo.xy * size;
  float ca = cos(geo.z), sa = sin(geo.z);
  float m;
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

vec2 frameToSourceUv(vec2 uv) {
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
    if (u_texture != 0.0 || u_clarity != 0.0) {
      float y0 = pow(max(ySrc, 0.0), 1.0 / ${f(SPATIAL.GAMMA)});
      vec4 c = texelFetch(u_detail, p, 0);
      float delta = 0.0;
      if (u_texture != 0.0) {
        delta += textureDelta(y0 - c.x,
          ${f(SPATIAL.TEXTURE_WEIGHTS[0])}, ${f(SPATIAL.TEXTURE_THRESH[0])});
        delta += textureDelta(c.x - c.y,
          ${f(SPATIAL.TEXTURE_WEIGHTS[1])}, ${f(SPATIAL.TEXTURE_THRESH[1])});
        delta += textureDelta(c.y - c.z,
          ${f(SPATIAL.TEXTURE_WEIGHTS[2])}, ${f(SPATIAL.TEXTURE_THRESH[2])});
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
  // per-pixel weight (Lightroom layering: locals stack on the globals)
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
