// WebGL2 preview renderer: one RGBA16UI texture, one fullscreen-triangle
// program, one float uniform per tone setting plus a view rect (zoom/crop
// window). A full re-render is a single draw call.

import { VERTEX_SHADER, FRAGMENT_SHADER } from "./shaders.js";
import { MASK } from "../tone/constants.js";
import { HSL_BAND_KEYS } from "../tone/tone-math.js";
import { ZERO_GEOMETRY, orientedDims, coverScale } from "../tone/geometry.js";

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
  "lightBalance",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "sharpening",
  "texture",
  "clarity",
  "dehaze",
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
  "invert",
  "grainAmount",
  "grainSize",
  "grainMidtones",
  "noise",
  "lumaNoise",
  "colorNoise",
  "noiseDetail",
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
 * Per-image presence aux from spatial-worker.js: interleaved à trous
 * detail planes (c1, c2, c3, clarity base), the Richardson-Lucy sharpening
 * delta, the refined haze amount, and the estimated airlight color.
 * @typedef {{ detail: Float32Array, sharpenD: Float32Array, dehazeD: Float32Array,
 *             lightBalanceW: Float32Array, chroma: Float32Array,
 *             airlight: [number, number, number],
 *             width: number, height: number }} PresenceAux
 */

/**
 * @typedef {{
 *   setImage(img: { pixels: Uint16Array, width: number, height: number }): void,
 *   setAux(aux: PresenceAux | null): void,
 *   setSize(width: number, height: number): void,
 *   render(settings: import("../tone/tone-math.js").ToneSettings, view?: ViewRect, opts?: { maskOverlay?: number, geometry?: import("../tone/geometry.js").Geometry }): void,
 *   computeHistogram(settings: import("../tone/tone-math.js").ToneSettings, view?: ViewRect, geometry?: import("../tone/geometry.js").Geometry): HistogramBins | null,
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
  const locOrient = gl.getUniformLocation(program, "u_orient");
  const locFlip = gl.getUniformLocation(program, "u_flip");
  const locRot = gl.getUniformLocation(program, "u_rot");
  const locCoverScale = gl.getUniformLocation(program, "u_coverScale");
  const locFrame = gl.getUniformLocation(program, "u_frame");
  const locMaskCount = gl.getUniformLocation(program, "u_maskCount");
  const locCompCount = gl.getUniformLocation(program, "u_compCount");
  const locCompGeo = gl.getUniformLocation(program, "u_compGeo");
  const locCompParam = gl.getUniformLocation(program, "u_compParam");
  const locCompInfo = gl.getUniformLocation(program, "u_compInfo");
  const locMaskAdjA = gl.getUniformLocation(program, "u_maskAdjA");
  const locMaskAdjB = gl.getUniformLocation(program, "u_maskAdjB");
  const locMaskAdjC = gl.getUniformLocation(program, "u_maskAdjC");
  const locMaskAdjD = gl.getUniformLocation(program, "u_maskAdjD");
  const locMaskOverlay = gl.getUniformLocation(program, "u_maskOverlay");
  const locHsl = gl.getUniformLocation(program, "u_hsl");
  const locHasAux = gl.getUniformLocation(program, "u_hasAux");
  const locAirlight = gl.getUniformLocation(program, "u_airlight");
  gl.uniform1i(gl.getUniformLocation(program, "u_image"), 0);
  // unit 1 is the histogram readback target; spatial aux lives on 2, 3, 5, 6, 7
  gl.uniform1i(gl.getUniformLocation(program, "u_detail"), 2);
  gl.uniform1i(gl.getUniformLocation(program, "u_dehazeD"), 3);
  gl.uniform1i(gl.getUniformLocation(program, "u_sharpenD"), 5);
  gl.uniform1i(gl.getUniformLocation(program, "u_lightBalanceW"), 6);
  gl.uniform1i(gl.getUniformLocation(program, "u_chromaD"), 7);
  // brush-mask coverage array lives on unit 4
  gl.uniform1i(gl.getUniformLocation(program, "u_brushMask"), 4);
  gl.uniform1i(locHasAux, 0);

  // Packed color-mixer band staging (hue, sat, lum per band), reused
  // across draws.
  const hslVals = new Float32Array(HSL_BAND_KEYS.length * 3);

  // Packed mask uniform staging, reused across draws: per-component
  // geometry/params plus per-group adjustments (adjC.w carries the group
  // invert flag).
  const compGeo = new Float32Array(MASK.MAX_COMPONENTS * 4);
  const compParam = new Float32Array(MASK.MAX_COMPONENTS * 4);
  const compInfo = new Int32Array(MASK.MAX_COMPONENTS * 2);
  const maskAdjA = new Float32Array(MASK.MAX * 4);
  const maskAdjB = new Float32Array(MASK.MAX * 4);
  const maskAdjC = new Float32Array(MASK.MAX * 4);
  const maskAdjD = new Float32Array(MASK.MAX * 4);

  /**
   * Flatten mask groups into the shader's component list, applying the
   * shader bounds and assigning brush texture-array layers densely in walk
   * order. Shared by setUniforms and syncBrushMasks so uniform packing and
   * layer uploads can never disagree.
   * @param {readonly import("../tone/mask-math.js").MaskGroup[]} groups
   * @returns {{ comps: { c: import("../tone/mask-math.js").MaskComponent,
   *                      group: number, layer: number }[],
   *             groupCount: number }}
   */
  const flattenGroups = (groups) => {
    /** @type {{ c: import("../tone/mask-math.js").MaskComponent,
     *           group: number, layer: number }[]} */
    const comps = [];
    const groupCount = Math.min(groups.length, MASK.MAX);
    let brushes = 0;
    for (let gi = 0; gi < groupCount; gi++) {
      for (const c of groups[gi].components) {
        if (comps.length >= MASK.MAX_COMPONENTS) break;
        let layer = -1;
        if (c.type === "brush") {
          if (brushes >= MASK.MAX_BRUSH_COMPONENTS) continue;
          layer = brushes;
          brushes += 1;
        }
        comps.push({ c, group: gi, layer });
      }
    }
    return { comps, groupCount };
  };

  // Brush (drawn) component coverage lives in an R8 TEXTURE_2D_ARRAY on
  // unit 4, LINEAR filtered so the GPU's bilinear fetch matches
  // sampleCoverage() in mask-math.js. Layers are assigned densely to brush
  // components in flattenGroups() walk order — identity is the component's
  // stable id, so adding or removing shapes never leaves a layer serving a
  // stale raster. The array is (re)allocated when the coverage grid dims
  // change; individual layers re-upload only when their component id or
  // coverageVersion changes (so active painting touches one layer, not the
  // whole array).
  const brushTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, brushTex);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // A 1×1×1 placeholder keeps the bound array texture *complete* so drivers
  // never warn even on frames with no brush masks (the shader never samples
  // it then, but the sampler is still bound on unit 4).
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    gl.R8,
    1,
    1,
    1,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    new Uint8Array(1),
  );
  gl.activeTexture(gl.TEXTURE0);
  let brushW = 0; // allocated grid dims of the array (0 = unallocated)
  let brushH = 0;
  /** Last-uploaded coverageVersion per layer; -1 forces a (re)upload. */
  const brushVersions = new Int32Array(MASK.MAX_BRUSH_COMPONENTS).fill(-1);
  /** Component id each layer was last uploaded for. */
  const brushLayerIds = new Array(MASK.MAX_BRUSH_COMPONENTS).fill("");

  /**
   * Ensure the coverage array is allocated at (w, h) and every brush
   * component's layer is current. Cheap when nothing changed. Uploads use
   * UNPACK_ALIGNMENT 1 since R8 rows aren't 4-byte aligned.
   * @param {ReturnType<typeof flattenGroups>["comps"]} comps
   */
  const syncBrushMasks = (comps) => {
    // Find the coverage grid dims from the first brush component (all
    // brushes on one frame share dims — they're sized from the same frame).
    let cw = 0;
    let ch = 0;
    for (const { c } of comps) {
      if (c.type === "brush" && c.coverageW && c.coverageH) {
        cw = c.coverageW;
        ch = c.coverageH;
        break;
      }
    }
    if (cw === 0) return; // no brush components → nothing to upload
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, brushTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (cw !== brushW || ch !== brushH) {
      // (Re)allocate the full layer budget once per grid size.
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        gl.R8,
        cw,
        ch,
        MASK.MAX_BRUSH_COMPONENTS,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        null,
      );
      brushW = cw;
      brushH = ch;
      brushVersions.fill(-1); // every layer is now stale
      brushLayerIds.fill("");
    }
    for (const { c, layer } of comps) {
      if (layer < 0 || !c.coverage) continue;
      // The UI keeps every raster on the frame grid (normalizeBrushGrids);
      // if corrupted data slips through anyway, skip the upload — a
      // transposed raster has the same byte count and would silently
      // scramble the layer. The layer stays zero (WebGL zero-initializes),
      // so the component reads as empty rather than garbage.
      if (c.coverageW !== cw || c.coverageH !== ch) continue;
      const ver = c.coverageVersion ?? 0;
      if (brushLayerIds[layer] !== c.id || brushVersions[layer] !== ver) {
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0,
          0,
          layer,
          cw,
          ch,
          1,
          gl.RED,
          gl.UNSIGNED_BYTE,
          c.coverage,
        );
        brushLayerIds[layer] = c.id;
        brushVersions[layer] = ver;
      }
    }
    gl.activeTexture(gl.TEXTURE0);
  };

  let imgW = 0;
  let imgH = 0;

  /**
   * @param {import("../tone/tone-math.js").ToneSettings} settings
   * @param {ViewRect} view
   * @param {number} maskOverlay mask index to visualize, -1 = off
   * @param {import("../tone/geometry.js").Geometry} geometry
   */
  const setUniforms = (settings, view, maskOverlay, geometry) => {
    for (const name of UNIFORMS) {
      gl.uniform1f(loc[name], settings[name]);
    }
    for (let i = 0; i < HSL_BAND_KEYS.length; i++) {
      const [hue, sat, lum] = HSL_BAND_KEYS[i];
      hslVals[i * 3] = settings[hue];
      hslVals[i * 3 + 1] = settings[sat];
      hslVals[i * 3 + 2] = settings[lum];
    }
    gl.uniform3fv(locHsl, hslVals);
    gl.uniform2f(locViewOffset, view.x, view.y);
    gl.uniform2f(locViewScale, view.w, view.h);

    const frame = orientedDims(geometry.orient, imgW, imgH);
    const rad = (geometry.angle * Math.PI) / 180;
    gl.uniform1i(locOrient, geometry.orient & 3);
    gl.uniform2i(locFlip, geometry.flipH ? 1 : 0, geometry.flipV ? 1 : 0);
    gl.uniform2f(locRot, Math.cos(rad), Math.sin(rad));
    gl.uniform1f(
      locCoverScale,
      coverScale(geometry.angle, frame.width, frame.height),
    );
    gl.uniform2f(locFrame, frame.width, frame.height);

    const groups = settings.masks ?? [];
    const { comps, groupCount } = flattenGroups(groups);
    for (let gi = 0; gi < groupCount; gi++) {
      const g = groups[gi];
      const a = g.adjustments;
      const o = gi * 4;
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
      maskAdjC[o + 2] = a.lightBalance ?? 0;
      maskAdjC[o + 3] = g.invert ? 1 : 0;
      maskAdjD[o] = a.sharpening ?? 0;
      maskAdjD[o + 1] = a.texture ?? 0;
      maskAdjD[o + 2] = a.clarity ?? 0;
      maskAdjD[o + 3] = a.dehaze ?? 0;
    }
    for (let ci = 0; ci < comps.length; ci++) {
      const { c: mk, group, layer } = comps[ci];
      const o = ci * 4;
      const linear = mk.type === "linear";
      const brush = mk.type === "brush";
      compGeo[o] = mk.x;
      compGeo[o + 1] = mk.y;
      compGeo[o + 2] = mk.angle;
      // type encoding: 0 linear, 1 radial, 2 brush
      compGeo[o + 3] = brush ? 2 : linear ? 0 : 1;
      // brush slot carries the array layer index in param.y; the analytic
      // params are unused for brushes
      compParam[o] = brush ? 0 : linear ? mk.range : mk.radiusX;
      compParam[o + 1] = brush ? layer : linear ? 0 : mk.radiusY;
      compParam[o + 2] = brush || linear ? 0 : mk.feather;
      compParam[o + 3] = mk.invert ? 1 : 0;
      compInfo[ci * 2] = group;
      compInfo[ci * 2 + 1] = mk.mode === "subtract" ? 1 : 0;
    }
    gl.uniform1i(locMaskCount, groupCount);
    gl.uniform1i(locCompCount, comps.length);
    gl.uniform4fv(locCompGeo, compGeo);
    gl.uniform4fv(locCompParam, compParam);
    gl.uniform2iv(locCompInfo, compInfo);
    gl.uniform4fv(locMaskAdjA, maskAdjA);
    gl.uniform4fv(locMaskAdjB, maskAdjB);
    gl.uniform4fv(locMaskAdjC, maskAdjC);
    gl.uniform4fv(locMaskAdjD, maskAdjD);
    gl.uniform1i(locMaskOverlay, maskOverlay < groupCount ? maskOverlay : -1);
    // bring the brush coverage array up to date (uploads only changed
    // layers; no-op when there are no brush components)
    syncBrushMasks(comps);
  };

  /** @param {number} unit */
  const createNearestTexture = (unit) => {
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };

  // Presence aux textures (image-res, sampled at the same texel as
  // u_image). Bound once; texImage2D in setAux re-allocates per image.
  createNearestTexture(gl.TEXTURE2);
  createNearestTexture(gl.TEXTURE3);
  createNearestTexture(gl.TEXTURE5);
  createNearestTexture(gl.TEXTURE6);
  createNearestTexture(gl.TEXTURE7);
  // Integer textures are non-filterable: NEAREST is mandatory.
  createNearestTexture(gl.TEXTURE0);

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
      imgW = width;
      imgH = height;
      hasImage = true;
      // stale aux belongs to the previous image — gate it off until the
      // spatial worker delivers this image's planes
      gl.uniform1i(locHasAux, 0);
    },

    /**
     * Upload (or clear, with null) the presence aux planes. Must match the
     * current image's dimensions.
     * @param {PresenceAux | null} aux
     */
    setAux(aux) {
      if (!aux) {
        gl.uniform1i(locHasAux, 0);
        return;
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        aux.width,
        aux.height,
        0,
        gl.RGBA,
        gl.FLOAT,
        aux.detail,
      );
      gl.activeTexture(gl.TEXTURE5);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R16F,
        aux.width,
        aux.height,
        0,
        gl.RED,
        gl.FLOAT,
        aux.sharpenD,
      );
      gl.activeTexture(gl.TEXTURE3);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R16F,
        aux.width,
        aux.height,
        0,
        gl.RED,
        gl.FLOAT,
        aux.dehazeD,
      );
      gl.activeTexture(gl.TEXTURE6);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R16F,
        aux.width,
        aux.height,
        0,
        gl.RED,
        gl.FLOAT,
        aux.lightBalanceW,
      );
      gl.activeTexture(gl.TEXTURE7);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RG16F,
        aux.width,
        aux.height,
        0,
        gl.RG,
        gl.FLOAT,
        aux.chroma,
      );
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform3f(
        locAirlight,
        aux.airlight[0],
        aux.airlight[1],
        aux.airlight[2],
      );
      gl.uniform1i(locHasAux, 1);
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
     * @param {{ maskOverlay?: number,
     *           geometry?: import("../tone/geometry.js").Geometry }} [opts]
     */
    render(settings, view = FULL_VIEW, opts = {}) {
      if (!hasImage) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      setUniforms(
        settings,
        view,
        opts.maskOverlay ?? -1,
        opts.geometry ?? ZERO_GEOMETRY,
      );
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
     * @param {import("../tone/geometry.js").Geometry} [geometry]
     * @returns {HistogramBins | null} null when no image is loaded
     */
    computeHistogram(settings, view = FULL_VIEW, geometry = ZERO_GEOMETRY) {
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
      // never let the overlay taint the bins
      setUniforms(settings, view, -1, geometry);
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
