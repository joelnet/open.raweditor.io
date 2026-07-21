// Sky-detection worker: runs a U²-NetP sky-segmentation model (2.2MB ncnn
// graph, wrapped in /skyseg/skyseg.mjs — see wasm/skyseg/) over the neutral
// preview and returns a brush-coverage-ready sky mask. One request per
// "+ Sky" press; the wasm module and model download lazily on the first one
// and stay cached for the session.
//
// The classical predecessor and why it was replaced are documented in
// docs/sky-mask-failed-attempt.md. Two parts of that attempt survive here
// by design: detection runs on the *neutral* (as-decoded) preview so the
// selection never shifts under slider moves, and the coarse result is
// joint-upsampled against the preview's encoded luma with the guided
// filter, which is what recovers tree branches and soft horizons from a
// 384px probability map.
//
// The input is mapped through frameToSource (with the straighten angle
// ignored — the auto-WB/auto-tone "close enough for statistics" policy) so
// the mask lands in frame space, matching the brush coverage grid's UV
// convention regardless of 90° turns and flips.

import { brushCoverageDims } from "./mask-math.js";
import { guidedFilter } from "./spatial.js";
import { frameToSource, orientedDims } from "./geometry.js";

/** Model input edge (px). The graph is fully convolutional but its own
 * demos run 320–384; 384 keeps the most horizon detail. */
const NET_RES = 384;
/** ImageNet normalization, per the model's reference inference code. */
const NET_MEAN = [0.485, 0.456, 0.406];
const NET_STD = [0.229, 0.224, 0.225];
/** No-sky guard: below this fraction of confident (>0.5) sky pixels the
 * result is "no sky" rather than an invented horizon. */
const SKY_MIN_FRAC = 0.02;
/** Guided-filter refinement: radius/eps in coverage-grid texels, tuned for
 * the 1024-long-edge brush grid (≈2.7× upsample from the net output). */
const SKY_GUIDED_RADIUS = 12;
const SKY_GUIDED_EPS = 1e-3;

/**
 * The emscripten module surface skyseg.mjs exports. HEAP views go stale
 * whenever wasm memory grows — re-read them from the module after any
 * _malloc or _skyseg_run, never cache across calls.
 * @typedef {{ _malloc(n: number): number, _free(p: number): void,
 *             _skyseg_load(param: number, bin: number): number,
 *             _skyseg_run(rgb: number, size: number, out: number): number,
 *             HEAPU8: Uint8Array, HEAPF32: Float32Array }} SkySegModule
 */

/** @type {Promise<SkySegModule> | null} */
let modulePromise = null;

/** Fetch + instantiate the wasm module and load the model into it, once.
 * The param/bin heap copies are deliberately never freed — the net may
 * reference them, and 2.3MB once per session is cheap. */
function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const base = "/skyseg/";
      /** @param {string} name */
      const fetchBytes = async (name) => {
        const res = await fetch(base + name);
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      };
      const [factory, param, bin] = await Promise.all([
        // the glue is bundled source (Vite can't import public/ files as
        // modules); the wasm+model are plain static assets under /skyseg/
        import("./skyseg/skyseg-module.mjs").then((m) => m.default),
        fetchBytes("skyseg.param"),
        fetchBytes("skyseg.bin"),
      ]);
      const mod = /** @type {SkySegModule} */ (
        await factory({ locateFile: () => base + "skyseg.wasm" })
      );
      // param is ncnn text format and must be NUL-terminated in the heap
      const paramPtr = mod._malloc(param.length + 1);
      mod.HEAPU8.set(param, paramPtr);
      mod.HEAPU8[paramPtr + param.length] = 0;
      const binPtr = mod._malloc(bin.length);
      mod.HEAPU8.set(bin, binPtr);
      const ret = mod._skyseg_load(paramPtr, binPtr);
      if (ret !== 0) throw new Error(`model load failed (${ret})`);
      return mod;
    })();
  }
  return modulePromise;
}

/**
 * Box-downsample the source-oriented preview into two frame-space grids in
 * one pass: per-channel means on the NET_RES² model grid and an encoded
 * (display-referred) luma plane on the brush coverage grid, both binned by
 * frame position so orientation and flips are already applied.
 * @param {Uint16Array} pixels RGBA u16, source-oriented
 * @param {number} width source px
 * @param {number} height
 * @param {import("./geometry.js").Geometry} g straighten angle already zeroed
 * @param {number} fw frame px
 * @param {number} fh
 * @param {number} cw coverage grid dims
 * @param {number} ch
 * @returns {{ input: Float32Array, guide: Float32Array }} NCHW net input +
 *   luma guide plane
 */
function buildPlanes(pixels, width, height, g, fw, fh, cw, ch) {
  const nn = NET_RES * NET_RES;
  const sum = new Float32Array(nn * 3);
  const cnt = new Float32Array(nn);
  const guideSum = new Float32Array(cw * ch);
  const guideCnt = new Float32Array(cw * ch);
  for (let fy = 0; fy < fh; fy++) {
    const ny = Math.min(NET_RES - 1, ((fy * NET_RES) / fh) | 0);
    const cy = Math.min(ch - 1, ((fy * ch) / fh) | 0);
    for (let fx = 0; fx < fw; fx++) {
      const [sx, sy] = frameToSource(g, fx + 0.5, fy + 0.5, width, height);
      const px = Math.min(width - 1, Math.max(0, sx | 0));
      const py = Math.min(height - 1, Math.max(0, sy | 0));
      const p = (py * width + px) * 4;
      const r = pixels[p] / 65535;
      const gr = pixels[p + 1] / 65535;
      const b = pixels[p + 2] / 65535;
      const nx = Math.min(NET_RES - 1, ((fx * NET_RES) / fw) | 0);
      const ni = ny * NET_RES + nx;
      sum[ni] += r;
      sum[ni + nn] += gr;
      sum[ni + nn * 2] += b;
      cnt[ni] += 1;
      const cx = Math.min(cw - 1, ((fx * cw) / fw) | 0);
      const ci = cy * cw + cx;
      // Rec.709 luma on the *encoded* values: cheap, and edges in
      // display-referred space are what the refinement should hug.
      guideSum[ci] += 0.2126 * r + 0.7152 * gr + 0.0722 * b;
      guideCnt[ci] += 1;
    }
  }
  const input = new Float32Array(nn * 3);
  for (let i = 0; i < nn; i++) {
    let n = cnt[i];
    let r;
    let gr;
    let b;
    if (n > 0) {
      r = sum[i] / n;
      gr = sum[i + nn] / n;
      b = sum[i + nn * 2] / n;
    } else {
      // frame smaller than the net grid: point-sample the cell center
      const fx = ((i % NET_RES) + 0.5) * (fw / NET_RES);
      const fy = ((i / NET_RES) | 0) * (fh / NET_RES) + 0.5;
      const [sx, sy] = frameToSource(g, fx, fy, width, height);
      const p =
        (Math.min(height - 1, Math.max(0, sy | 0)) * width +
          Math.min(width - 1, Math.max(0, sx | 0))) *
        4;
      r = pixels[p] / 65535;
      gr = pixels[p + 1] / 65535;
      b = pixels[p + 2] / 65535;
    }
    input[i] = (r - NET_MEAN[0]) / NET_STD[0];
    input[i + nn] = (gr - NET_MEAN[1]) / NET_STD[1];
    input[i + nn * 2] = (b - NET_MEAN[2]) / NET_STD[2];
  }
  const guide = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    guide[i] = guideCnt[i] > 0 ? guideSum[i] / guideCnt[i] : 0;
  }
  return { input, guide };
}

/**
 * Bilinearly sample the net probability grid at frame UV (texel-center
 * convention, clamp-to-edge — the sampleCoverage recipe).
 * @param {Float32Array} prob NET_RES² plane
 * @param {number} u @param {number} v
 */
function sampleProb(prob, u, v) {
  const fx = u * NET_RES - 0.5;
  const fy = v * NET_RES - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const cx0 = Math.min(Math.max(x0, 0), NET_RES - 1);
  const cx1 = Math.min(Math.max(x0 + 1, 0), NET_RES - 1);
  const cy0 = Math.min(Math.max(y0, 0), NET_RES - 1);
  const cy1 = Math.min(Math.max(y0 + 1, 0), NET_RES - 1);
  const top =
    prob[cy0 * NET_RES + cx0] * (1 - tx) + prob[cy0 * NET_RES + cx1] * tx;
  const bot =
    prob[cy1 * NET_RES + cx0] * (1 - tx) + prob[cy1 * NET_RES + cx1] * tx;
  return top * (1 - ty) + bot * ty;
}

/**
 * @param {SkySegModule} mod
 * @param {Float32Array} input NCHW normalized planes
 * @returns {Float32Array} NET_RES² sky probability, clamped to [0, 1]
 */
function runNet(mod, input) {
  const nn = NET_RES * NET_RES;
  const inPtr = mod._malloc(input.length * 4);
  mod.HEAPF32.set(input, inPtr >> 2);
  const outPtr = mod._malloc(nn * 4);
  const ret = mod._skyseg_run(inPtr, NET_RES, outPtr);
  if (ret !== 0) {
    mod._free(inPtr);
    mod._free(outPtr);
    throw new Error(`inference failed (${ret})`);
  }
  const prob = new Float32Array(nn);
  // fresh view: _skyseg_run may have grown wasm memory
  prob.set(mod.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + nn));
  mod._free(inPtr);
  mod._free(outPtr);
  for (let i = 0; i < nn; i++) prob[i] = Math.min(Math.max(prob[i], 0), 1);
  return prob;
}

const ctx = /** @type {any} */ (self);

ctx.onmessage = async (/** @type {MessageEvent} */ e) => {
  const { pixels, width, height, orient, flipH, flipV } = e.data;
  try {
    const g = { orient, angle: 0, flipH, flipV };
    const { width: fw, height: fh } = orientedDims(orient, width, height);
    const { w: cw, h: ch } = brushCoverageDims(fw, fh);
    const mod = await loadModule();
    const { input, guide } = buildPlanes(
      pixels,
      width,
      height,
      g,
      fw,
      fh,
      cw,
      ch,
    );
    const prob = runNet(mod, input);
    // No-sky guard: an empty mask is better than an invented horizon. The
    // output is the net's own sigmoid — never min-max stretched, which
    // would amplify noise on skyless images into fake confidence.
    let confident = 0;
    for (let i = 0; i < prob.length; i++) if (prob[i] > 0.5) confident++;
    if (confident / prob.length < SKY_MIN_FRAC) {
      ctx.postMessage({ type: "none" });
      return;
    }
    // Edge-aware upsample net → coverage grid: bilinear to the brush grid,
    // then guided-filter against the luma plane so the mask hugs skylines.
    const n = cw * ch;
    const base = new Float32Array(n);
    for (let y = 0; y < ch; y++) {
      const v = (y + 0.5) / ch;
      for (let x = 0; x < cw; x++) {
        base[y * cw + x] = sampleProb(prob, (x + 0.5) / cw, v);
      }
    }
    const refined = guidedFilter(
      guide,
      base,
      cw,
      ch,
      SKY_GUIDED_RADIUS,
      SKY_GUIDED_EPS,
    );
    const coverage = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      coverage[i] = Math.round(Math.min(Math.max(refined[i], 0), 1) * 255);
    }
    ctx.postMessage({ type: "done", coverage, w: cw, h: ch }, [
      coverage.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({
      type: "error",
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }
};
