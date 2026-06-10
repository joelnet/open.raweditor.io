// WebGL2 preview renderer: one RGBA16UI texture, one fullscreen-triangle
// program, eight float uniforms. A full re-render is a single draw call.

import { VERTEX_SHADER, FRAGMENT_SHADER } from "./shaders.js";

const UNIFORMS = /** @type {const} */ ([
  "temp",
  "tint",
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
]);

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} type
 * @param {string} source
 */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${info}`);
  }
  return shader;
}

/**
 * @typedef {{ r: Uint32Array, g: Uint32Array, b: Uint32Array }} HistogramBins
 */

/**
 * @typedef {{
 *   setImage(img: { pixels: Uint16Array, width: number, height: number }): void,
 *   setSize(width: number, height: number): void,
 *   render(settings: import("../tone/tone-math.js").ToneSettings): void,
 *   computeHistogram(settings: import("../tone/tone-math.js").ToneSettings): HistogramBins | null,
 * }} Renderer
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Renderer | null} null when WebGL2 is unavailable
 */
export function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(
    program,
    compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);

  // Fullscreen triangle is generated from gl_VertexID; an empty VAO is
  // still required for a valid draw.
  gl.bindVertexArray(gl.createVertexArray());

  /** @type {Record<string, WebGLUniformLocation | null>} */
  const loc = {};
  for (const name of UNIFORMS) {
    loc[name] = gl.getUniformLocation(program, `u_${name}`);
  }
  gl.uniform1i(gl.getUniformLocation(program, "u_image"), 0);

  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Integer textures are non-filterable: NEAREST is mandatory.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let hasImage = false;

  // Histogram readback target: the same shader rendered at thumbnail size.
  // The shader samples by normalized UV, so a small viewport is a uniform
  // (unbiased) subsample of the full preview.
  const HISTO_W = 256;
  const HISTO_H = 160;
  /** @type {WebGLFramebuffer | null} */
  let histoFbo = null;
  const histoPixels = new Uint8Array(HISTO_W * HISTO_H * 4);
  /** @type {HistogramBins} */
  const histoBins = {
    r: new Uint32Array(256),
    g: new Uint32Array(256),
    b: new Uint32Array(256),
  };

  const renderer = {
    /**
     * Upload a preview image (RGBA u16, linear) to the GPU.
     * @param {{ pixels: Uint16Array, width: number, height: number }} img
     */
    setImage({ pixels, width, height }) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16UI,
        width,
        height,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_SHORT,
        pixels,
      );
      hasImage = true;
    },

    /**
     * Size the canvas backing store (device pixels).
     * @param {number} width
     * @param {number} height
     */
    setSize(width, height) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    },

    /**
     * Draw with the given tone settings (exposure in EV, rest in [-1, 1]).
     * @param {import("../tone/tone-math.js").ToneSettings} settings
     */
    render(settings) {
      if (!hasImage) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      for (const name of UNIFORMS) {
        gl.uniform1f(loc[name], settings[name]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    /**
     * Render at thumbnail size with the given settings and bin the result
     * into 256-level RGB histograms of the display-referred (sRGB) output.
     * The returned arrays are reused across calls — consume immediately.
     * @param {import("../tone/tone-math.js").ToneSettings} settings
     * @returns {HistogramBins | null} null when no image is loaded
     */
    computeHistogram(settings) {
      if (!hasImage) return null;
      if (!histoFbo) {
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, HISTO_W, HISTO_H);
        gl.activeTexture(gl.TEXTURE0);
        histoFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, histoFbo);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          tex,
          0,
        );
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, histoFbo);
      }
      gl.viewport(0, 0, HISTO_W, HISTO_H);
      for (const name of UNIFORMS) {
        gl.uniform1f(loc[name], settings[name]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(
        0,
        0,
        HISTO_W,
        HISTO_H,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        histoPixels,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      histoBins.r.fill(0);
      histoBins.g.fill(0);
      histoBins.b.fill(0);
      for (let i = 0; i < histoPixels.length; i += 4) {
        histoBins.r[histoPixels[i]]++;
        histoBins.g[histoPixels[i + 1]]++;
        histoBins.b[histoPixels[i + 2]]++;
      }
      return histoBins;
    },
  };
  return renderer;
}
