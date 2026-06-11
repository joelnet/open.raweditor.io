// GLSL for the preview path. The fragment shader mirrors tone-math.js
// step-for-step (white balance → exposure → whites/blacks → contrast →
// highlights/shadows → vibrance/saturation → color grading → sRGB encode);
// constants are interpolated from tone/constants.js so the GPU preview and
// the CPU export can never drift apart.

import { TONE, GRADE, INPUT_TRANSFER, LUMA } from "../tone/constants.js";

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
uniform float u_vibrance;       // [-1, 1]
uniform float u_saturation;     // [-1, 1]
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

in vec2 v_uv;
out vec4 outColor;

${DECODE_INPUT_GLSL}

vec3 srgbEncode(vec3 c) {
  bvec3 lo = lessThanEqual(c, vec3(0.0031308));
  vec3 a = c * 12.92;
  vec3 b = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
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

void main() {
  ivec2 ts = textureSize(u_image, 0);
  ivec2 p = clamp(ivec2(v_uv * vec2(ts)), ivec2(0), ts - 1);
  vec3 rgb = decodeInput(vec3(texelFetch(u_image, p, 0).rgb) / 65535.0);

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

  // 7. color grading: per-zone luminance gain (linear light), then per-zone
  // soft-light tint on the display-referred values. Masks are computed once,
  // before the luminance gain moves the pixel.
  bool grading = u_gradeShadowSat != 0.0 || u_gradeMidSat != 0.0
    || u_gradeHighSat != 0.0 || u_gradeShadowLum != 0.0
    || u_gradeMidLum != 0.0 || u_gradeHighLum != 0.0;
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
    outColor = vec4(clamp(e, 0.0, 1.0), 1.0);
    return;
  }

  // 8. clamp + display encode
  outColor = vec4(srgbEncode(clamp(rgb, 0.0, 1.0)), 1.0);
}
`;
