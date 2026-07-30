// Already-developed bitmap images (JPEG, HEIC): magic-byte detection for
// the decode router, and the sRGB → linear conversion that turns an 8-bit
// RGBA decode into the linear 16-bit RGB layout the rest of the app
// expects from LibRaw (see tone/constants.js INPUT_TRANSFER). The actual
// decoding lives in bitmap-worker.js. Pure functions; node:test-able.

/** ISOBMFF brands that mean "HEIF container with HEVC-coded stills" — what
 * iPhones and recent Android cameras write. AVIF brands are deliberately
 * absent: the wasm fallback decoder only carries an HEVC decoder. */
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

/** @param {Uint8Array} bytes @param {number} off */
function fourcc(bytes, off) {
  return String.fromCharCode(
    bytes[off],
    bytes[off + 1],
    bytes[off + 2],
    bytes[off + 3],
  );
}

/** @param {Uint8Array} bytes */
export function isJpeg(bytes) {
  return (
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

/** @param {Uint8Array} bytes */
export function isHeic(bytes) {
  if (bytes.length < 16 || fourcc(bytes, 4) !== "ftyp") return false;
  const size = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  if (size < 16 || size > bytes.length) return false;
  if (HEIC_BRANDS.has(fourcc(bytes, 8))) return true; // major brand
  // bytes 12–16 are the minor version; compatible brands follow.
  for (let off = 16; off + 4 <= size; off += 4) {
    if (HEIC_BRANDS.has(fourcc(bytes, off))) return true;
  }
  return false;
}

/** Does this file take the bitmap decode path instead of LibRaw?
 * @param {Uint8Array} bytes */
export function isBitmapImage(bytes) {
  return isJpeg(bytes) || isHeic(bytes);
}

/** Display P3 → sRGB in linear light (both D65), row-major 3×3. Applied
 * when the wasm HEIC decoder hands over P3-encoded pixels — the native
 * browser decode path color-manages to sRGB on its own. */
// prettier-ignore
export const P3_TO_SRGB = [
  1.2249401763, -0.2249401763, 0,
  -0.0420569547, 1.0420569547, 0,
  -0.0196375546, -0.0786360456, 1.0982736002,
];

/** sRGB u8 → linear, as u16 (fast path) and float (matrix path). */
const LINEAR_16 = new Uint16Array(256);
const LINEAR_F = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  const lin = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  LINEAR_F[i] = lin;
  LINEAR_16[i] = Math.round(lin * 65535);
}

/**
 * Convert an 8-bit sRGB RGBA decode to linear 16-bit RGB, optionally
 * through a 3×3 gamut matrix (applied in linear light, hard-clipped to
 * sRGB — fine for a starting point the tone pipeline re-shapes anyway).
 * @param {{ data: Uint8Array | Uint8ClampedArray, width: number,
 *           height: number }} rgba
 * @param {number[] | null} [matrix]
 * @returns {{ data: Uint16Array, width: number, height: number,
 *             colors: 3, bits: 16 }}
 */
export function linearizeRgba8(rgba, matrix = null) {
  const { data, width, height } = rgba;
  const n = width * height;
  const out = new Uint16Array(n * 3);
  if (matrix) {
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = matrix;
    for (let i = 0, o = 0, p = 0; i < n; i++, o += 3, p += 4) {
      const r = LINEAR_F[data[p]];
      const g = LINEAR_F[data[p + 1]];
      const b = LINEAR_F[data[p + 2]];
      let R = m00 * r + m01 * g + m02 * b;
      let G = m10 * r + m11 * g + m12 * b;
      let B = m20 * r + m21 * g + m22 * b;
      R = R < 0 ? 0 : R > 1 ? 1 : R;
      G = G < 0 ? 0 : G > 1 ? 1 : G;
      B = B < 0 ? 0 : B > 1 ? 1 : B;
      out[o] = (R * 65535 + 0.5) | 0;
      out[o + 1] = (G * 65535 + 0.5) | 0;
      out[o + 2] = (B * 65535 + 0.5) | 0;
    }
  } else {
    for (let i = 0, o = 0, p = 0; i < n; i++, o += 3, p += 4) {
      out[o] = LINEAR_16[data[p]];
      out[o + 1] = LINEAR_16[data[p + 1]];
      out[o + 2] = LINEAR_16[data[p + 2]];
    }
  }
  return { data: out, width, height, colors: 3, bits: 16 };
}
