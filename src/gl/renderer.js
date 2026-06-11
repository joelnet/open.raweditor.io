// WebGL2 preview renderer: one RGBA16UI texture, one fullscreen-triangle
// program, one float uniform per tone setting plus a view rect (zoom/crop
// window). A full re-render is a single draw call.

import { VERTEX_SHADER, FRAGMENT_SHADER } from "./shaders.js";
import { MASK } from "../tone/constants.js";

/**
 * Normalized window into the image (UV space, y = 0 at the top).
 * @typedef {{ x: number, y: number, w: number, h: number }} ViewRect
 */

/** The whole image: the default view. */
export const FULL_VIEW = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

const UNIFORMS = /** @type {const} */ ([
  "temp",
  "tint",
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "vibrance",
  "saturation",
  "gradeShadowHue",
  "gradeShadowSat",
  "gradeShadowLum",
  "gradeMidHue",
  "gradeMidSat",
  "gradeMidLum",
  "gradeHighHue",
  "gradeHighSat",
  "gradeHighLum",
  "gradeBlending",
  "gradeBalance",
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
 *   render(settings: import("../tone/tone-math.js").ToneSettings, view?: ViewRect, opts?: { maskOverlay?: number }): void,
 *   computeHistogram(settings: import("../tone/tone-math.js").ToneSettings, view?: ViewRect): HistogramBins | null,
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
  const locViewOffset = gl.getUniformLocation(program, "u_view_offset");
  const locViewScale = gl.getUniformLocation(program, "u_view_scale");
  const locMaskCount = gl.getUniformLocation(program, "u_maskCount");
  const locMaskGeo = gl.getUniformLocation(program, "u_maskGeo");
  const locMaskParam = gl.getUniformLocation(program, "u_maskParam");
  const locMaskAdjA = gl.getUniformLocation(program, "u_maskAdjA");
  const locMaskAdjB = gl.getUniformLocation(program, "u_maskAdjB");
  const locMaskAdjC = gl.getUniformLocation(program, "u_maskAdjC");
  const locMaskOverlay = gl.getUniformLocation(program, "u_maskOverlay");
  gl.uniform1i(gl.getUniformLocation(program, "u_image"), 0);

  // Packed mask uniform staging, reused across draws.
  const maskGeo = new Float32Array(MASK.MAX * 4);
  const maskParam = new Float32Array(MASK.MAX * 4);
  const maskAdjA = new Float32Array(MASK.MAX * 4);
  const maskAdjB = new Float32Array(MASK.MAX * 4);
  const maskAdjC = new Float32Array(MASK.MAX * 4);

  /**
   * @param {import("../tone/tone-math.js").ToneSettings} settings
   * @param {ViewRect} view
   * @param {number} maskOverlay mask index to visualize, -1 = off
   */
  const setUniforms = (settings, view, maskOverlay) => {
    for (const name of UNIFORMS) {
      gl.uniform1f(loc[name], settings[name]);
    }
    gl.uniform2f(locViewOffset, view.x, view.y);
    gl.uniform2f(locViewScale, view.w, view.h);

    const masks = settings.masks ?? [];
    const count = Math.min(masks.length, MASK.MAX);
    for (let i = 0; i < count; i++) {
      const mk = masks[i];
      const a = mk.adjustments;
      const o = i * 4;
      const linear = mk.type === "linear";
      maskGeo[o] = mk.x;
      maskGeo[o + 1] = mk.y;
      maskGeo[o + 2] = mk.angle;
      maskGeo[o + 3] = linear ? 0 : 1;
      maskParam[o] = linear ? mk.range : mk.radiusX;
      maskParam[o + 1] = linear ? 0 : mk.radiusY;
      maskParam[o + 2] = linear ? 0 : mk.feather;
      maskParam[o + 3] = mk.invert ? 1 : 0;
      maskAdjA[o] = a.temp;
      maskAdjA[o + 1] = a.tint;
      maskAdjA[o + 2] = a.exposure;
      maskAdjA[o + 3] = a.contrast;
      maskAdjB[o] = a.highlights;
      maskAdjB[o + 1] = a.shadows;
      maskAdjB[o + 2] = a.whites;
      maskAdjB[o + 3] = a.blacks;
      maskAdjC[o] = a.vibrance;
      maskAdjC[o + 1] = a.saturation;
      maskAdjC[o + 2] = 0;
      maskAdjC[o + 3] = 0;
    }
    gl.uniform1i(locMaskCount, count);
    gl.uniform4fv(locMaskGeo, maskGeo);
    gl.uniform4fv(locMaskParam, maskParam);
    gl.uniform4fv(locMaskAdjA, maskAdjA);
    gl.uniform4fv(locMaskAdjB, maskAdjB);
    gl.uniform4fv(locMaskAdjC, maskAdjC);
    gl.uniform1i(locMaskOverlay, maskOverlay < count ? maskOverlay : -1);
  };

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
     * Draw with the given tone settings (exposure in EV, rest in [-1, 1]),
     * showing only the view rect (zoom/crop window) of the image.
     * `maskOverlay` tints that mask's coverage red (preview aid).
     * @param {import("../tone/tone-math.js").ToneSettings} settings
     * @param {ViewRect} [view]
     * @param {{ maskOverlay?: number }} [opts]
     */
    render(settings, view = FULL_VIEW, opts = {}) {
      if (!hasImage) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      setUniforms(settings, view, opts.maskOverlay ?? -1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    /**
     * Render at thumbnail size with the given settings and bin the result
     * into 256-level RGB histograms of the display-referred (sRGB) output.
     * `view` should be the crop rect (not the zoom window) so the curve
     * always reflects what an export would contain.
     * The returned arrays are reused across calls — consume immediately.
     * @param {import("../tone/tone-math.js").ToneSettings} settings
     * @param {ViewRect} [view]
     * @returns {HistogramBins | null} null when no image is loaded
     */
    computeHistogram(settings, view = FULL_VIEW) {
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
      setUniforms(settings, view, -1); // never let the overlay taint the bins
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
