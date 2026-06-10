// GLSL for the preview path. The fragment shader mirrors tone-math.js
// step-for-step (exposure → whites/blacks → contrast → highlights/shadows →
// sRGB encode); constants are interpolated from tone/constants.js so the
// GPU preview and the CPU export can never drift apart.

import { TONE, INPUT_TRANSFER, LUMA } from "../tone/constants.js";

/** @param {number} n */
const f = (n) => n.toFixed(6);

export const VERTEX_SHADER = `#version 300 es
// Bufferless fullscreen triangle; v_uv y-flipped so texel row 0 (image top)
// lands at the top of the canvas.
out vec2 v_uv;
void main() {
  vec2 pos = vec2(
    gl_VertexID == 1 ? 3.0 : -1.0,
    gl_VertexID == 2 ? 3.0 : -1.0
  );
  v_uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
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
uniform float u_exposure;       // EV
uniform float u_contrast;       // [-1, 1]
uniform float u_highlights;     // [-1, 1]
uniform float u_shadows;        // [-1, 1]
uniform float u_whites;         // [-1, 1]
uniform float u_blacks;         // [-1, 1]

in vec2 v_uv;
out vec4 outColor;

${DECODE_INPUT_GLSL}

vec3 srgbEncode(vec3 c) {
  bvec3 lo = lessThanEqual(c, vec3(0.0031308));
  vec3 a = c * 12.92;
  vec3 b = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(b, a, vec3(lo));
}

void main() {
  ivec2 ts = textureSize(u_image, 0);
  ivec2 p = clamp(ivec2(v_uv * vec2(ts)), ivec2(0), ts - 1);
  vec3 rgb = decodeInput(vec3(texelFetch(u_image, p, 0).rgb) / 65535.0);

  // 1. exposure
  rgb *= exp2(u_exposure);

  // 2. whites / blacks: levels remap (+whites brightens, +blacks lifts)
  float white = 1.0 - ${f(TONE.WHITES_RANGE)} * u_whites;
  float black = -${f(TONE.BLACKS_RANGE)} * u_blacks;
  rgb = (rgb - black) / max(white - black, 1e-4);

  // 3. contrast: power curve pivoting on middle gray
  rgb = max(rgb, vec3(0.0));
  if (u_contrast != 0.0) {
    float c = u_contrast >= 0.0 ? 1.0 + u_contrast : 1.0 / (1.0 - u_contrast);
    rgb = ${f(TONE.PIVOT)} * pow(rgb / ${f(TONE.PIVOT)}, vec3(c));
  }

  // 4. highlights / shadows: luminance-masked exposure gain
  float y = dot(rgb, vec3(${f(LUMA[0])}, ${f(LUMA[1])}, ${f(LUMA[2])}));
  float ye = sqrt(clamp(y, 0.0, 1.0));
  float mS = 1.0 - smoothstep(${f(TONE.SHADOW_MASK[0])}, ${f(TONE.SHADOW_MASK[1])}, ye);
  float mH = smoothstep(${f(TONE.HIGHLIGHT_MASK[0])}, ${f(TONE.HIGHLIGHT_MASK[1])}, ye);
  rgb *= exp2(${f(TONE.SH_STRENGTH_EV)} * (u_shadows * mS + u_highlights * mH));

  // 5. clamp + display encode
  outColor = vec4(srgbEncode(clamp(rgb, 0.0, 1.0)), 1.0);
}
`;
