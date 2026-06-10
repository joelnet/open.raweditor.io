// CPU box-filter downscale of decoded RAW data to a GPU-friendly preview
// size. Runs once per opened file; pure function so it's node:test-able.

export const MAX_PREVIEW_EDGE = 2560;

/**
 * Downscale 3- or 4-channel u8/u16 image data by an integer factor so the
 * long edge fits maxEdge, emitting RGBA u16 (alpha = 65535) ready for a
 * WebGL2 RGBA16UI texture upload. Factor 1 is a straight RGBA16 repack.
 * Partial boxes at the right/bottom edges average over the actual samples.
 *
 * @param {{ data: Uint16Array | Uint8Array, width: number, height: number,
 *           colors: number, bits: number }} image
 * @param {number} [maxEdge]
 * @returns {{ pixels: Uint16Array, width: number, height: number }}
 */
export function boxDownscaleToRgba16(image, maxEdge = MAX_PREVIEW_EDGE) {
  const { data, width, height, colors, bits } = image;
  if (colors !== 3 && colors !== 4) {
    throw new Error(`unsupported channel count: ${colors}`);
  }
  const to16 = bits === 16 ? 1 : 257; // 255 * 257 = 65535
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / maxEdge));
  const outW = Math.ceil(width / factor);
  const outH = Math.ceil(height / factor);
  const pixels = new Uint16Array(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    const y0 = oy * factor;
    const y1 = Math.min(y0 + factor, height);
    for (let ox = 0; ox < outW; ox++) {
      const x0 = ox * factor;
      const x1 = Math.min(x0 + factor, width);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * colors;
        for (let x = x0; x < x1; x++) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          i += colors;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const o = (oy * outW + ox) * 4;
      pixels[o] = (r / count) * to16;
      pixels[o + 1] = (g / count) * to16;
      pixels[o + 2] = (b / count) * to16;
      pixels[o + 3] = 65535;
    }
  }
  return { pixels, width: outW, height: outH };
}
