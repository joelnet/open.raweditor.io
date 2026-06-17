// Presence analysis worker: computes the slider-independent aux planes
// (à trous detail levels + refined haze amount + airlight) from the
// preview pixels, once per opened file, off the main thread. The result
// uploads straight into the renderer's aux textures (renderer.setAux);
// slider moves never re-enter this worker.

import {
  lumaFromRgba16,
  computeDetailPlanes,
  computeSharpenDeltaPlane,
  computeLightBalanceWeightPlane,
  computeChromaDenoiseFromRgba16,
  computeDehazeAux,
  computeDehazePlane,
  downsampleRgbFromRgba16,
} from "./spatial.js";

const ctx = /** @type {any} */ (self);

ctx.onmessage = (/** @type {MessageEvent} */ e) => {
  const { pixels, width, height } = e.data;
  try {
    const luma = lumaFromRgba16(pixels, width, height);
    const { c1, c2, c3, base } = computeDetailPlanes(luma, width, height);
    const n = width * height;
    const detail = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      detail[i * 4] = c1[i];
      detail[i * 4 + 1] = c2[i];
      detail[i * 4 + 2] = c3[i];
      detail[i * 4 + 3] = base[i];
    }
    const sharpenD = computeSharpenDeltaPlane(luma, width, height);
    const lightBalanceW = computeLightBalanceWeightPlane(luma, width, height);
    const chroma = computeChromaDenoiseFromRgba16(pixels, luma, width, height);
    const aux = computeDehazeAux(
      downsampleRgbFromRgba16(pixels, width, height),
    );
    const dehazeD = computeDehazePlane(aux, luma, width, height);
    ctx.postMessage(
      {
        type: "done",
        aux: {
          detail,
          sharpenD,
          dehazeD,
          lightBalanceW,
          chroma,
          airlight: aux.airlight,
          width,
          height,
        },
      },
      [
        detail.buffer,
        sharpenD.buffer,
        dehazeD.buffer,
        lightBalanceW.buffer,
        chroma.buffer,
      ],
    );
  } catch (err) {
    ctx.postMessage({
      type: "error",
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }
};
