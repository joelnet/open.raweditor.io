// Develop a decoded LinearRaw (already-demosaiced RGB) DNG payload into the
// same thing libraw-wasm hands the app: linear-light sRGB, 16-bit, camera
// white balance applied, orientation corrected. Classic dcraw math — black/
// white scaling, AsShotNeutral gains, ColorMatrix → sRGB — nothing more.
//
// Deliberately NOT the full DNG color model: no dual-illuminant matrix
// interpolation by shot temperature, no ForwardMatrix/CameraCalibration/
// AnalogBalance, no OpcodeList processing. That matches LibRaw's own
// default rendering (single D65 matrix + camera neutral), and the editor's
// WB/tone sliders exist precisely to take it from there. Inputs that would
// come out *wrong* rather than merely neutral (linearization tables,
// patterned black levels, ...) are rejected in jxl-worker.js instead.
//
// Pure functions, node:test-able.

/** sRGB (D65) → CIE XYZ, row-major. */
const XYZ_FROM_SRGB = [
  0.412453, 0.35758, 0.180423, 0.212671, 0.71516, 0.072169, 0.019334, 0.119193,
  0.950227,
];

/** EXIF LightSource value for D65. */
const ILLUMINANT_D65 = 21;

/**
 * 3×3 inverse. Throws on a singular matrix — a DNG whose color matrix
 * cannot be inverted is corrupt beyond developing.
 * @param {number[]} m row-major 9
 * @returns {number[]}
 */
export function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) throw new Error("singular color matrix");
  return [
    A / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}

/**
 * Camera→linear-sRGB matrix from a DNG ColorMatrix (which maps XYZ→camera),
 * the dcraw way: compose camera←sRGB, normalize its rows to sum 1 (so the
 * white-balanced camera neutral maps to sRGB white), then invert.
 * @param {number[]} xyzToCam row-major 9
 * @returns {number[]} row-major 9, sRGB←camera
 */
export function camToSrgbMatrix(xyzToCam) {
  const camFromSrgb = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) {
        camFromSrgb[r * 3 + c] +=
          xyzToCam[r * 3 + k] * XYZ_FROM_SRGB[k * 3 + c];
      }
    }
  }
  for (let r = 0; r < 3; r++) {
    const sum =
      camFromSrgb[r * 3] + camFromSrgb[r * 3 + 1] + camFromSrgb[r * 3 + 2];
    if (sum) {
      camFromSrgb[r * 3] /= sum;
      camFromSrgb[r * 3 + 1] /= sum;
      camFromSrgb[r * 3 + 2] /= sum;
    }
  }
  return invert3x3(camFromSrgb);
}

/**
 * Pick the color matrix calibrated for daylight, matching LibRaw's default
 * development (it uses the D65 matrix; interpolation by shot illuminant is
 * out of scope for camera-neutral rendering).
 * @param {import("./dng.js").JxlDng} dng
 * @returns {number[] | null}
 */
export function pickColorMatrix(dng) {
  if (
    dng.colorMatrix2 &&
    (dng.calibrationIlluminant2 === ILLUMINANT_D65 || !dng.colorMatrix1)
  ) {
    return dng.colorMatrix2;
  }
  if (
    dng.colorMatrix1 &&
    (dng.calibrationIlluminant1 === ILLUMINANT_D65 || !dng.colorMatrix2)
  ) {
    return dng.colorMatrix1;
  }
  // Neither is tagged D65: DNG convention puts the daylight matrix second.
  return dng.colorMatrix2 ?? dng.colorMatrix1;
}

/**
 * Width/height of the image after the given TIFF orientation is applied.
 * @param {number} orientation TIFF 274 value (1..8)
 * @param {number} w
 * @param {number} h
 */
export function orientedSize(orientation, w, h) {
  return orientation >= 5 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Destination pixel index for source pixel (x, y) under a TIFF orientation,
 * in the oriented image (row-major).
 * @param {number} orientation
 * @param {number} x
 * @param {number} y
 * @param {number} w source width
 * @param {number} h source height
 * @returns {number}
 */
export function orientIndex(orientation, x, y, w, h) {
  switch (orientation) {
    case 2:
      return y * w + (w - 1 - x); // mirror horizontal
    case 3:
      return (h - 1 - y) * w + (w - 1 - x); // rotate 180
    case 4:
      return (h - 1 - y) * w + x; // mirror vertical
    case 5:
      return x * h + y; // transpose
    case 6:
      return x * h + (h - 1 - y); // rotate 90 CW
    case 7:
      return (w - 1 - x) * h + (h - 1 - y); // transverse
    case 8:
      return (w - 1 - x) * h + y; // rotate 90 CCW
    default:
      return y * w + x;
  }
}

/**
 * Develop LinearRaw RGB samples in place of LibRaw: black/white scale,
 * white balance, matrix to linear sRGB, clip, orient. Returns a new
 * buffer shaped like libraw-wasm's RawImageData.
 *
 * With `colorimetric` set, the samples are already full-scale linear sRGB
 * (an XYB JXL payload after the decoder's color conversion) — the DNG
 * color tags do not apply to them, so only orientation is performed.
 *
 * @param {Uint16Array} data interleaved RGB, dng.width × dng.height
 * @param {import("./dng.js").JxlDng} dng
 * @param {{ colorimetric?: boolean }} [opts]
 * @returns {{ data: Uint16Array, width: number, height: number,
 *             colors: 3, bits: 16 }}
 */
export function developLinearRgb(data, dng, opts = {}) {
  const { width: w, height: h, orientation } = dng;
  if (data.length < w * h * 3) throw new Error("truncated raw data");

  if (opts.colorimetric) {
    const oriented = orientedSize(orientation, w, h);
    if (orientation === 1) {
      return { data, width: w, height: h, colors: 3, bits: 16 };
    }
    const out = new Uint16Array(w * h * 3);
    let i = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 3) {
        const o = orientIndex(orientation, x, y, w, h) * 3;
        out[o] = data[i];
        out[o + 1] = data[i + 1];
        out[o + 2] = data[i + 2];
      }
    }
    return {
      data: out,
      width: oriented.width,
      height: oriented.height,
      colors: 3,
      bits: 16,
    };
  }

  // Per-channel black/white scaling. BlackLevel may repeat over a CFA
  // pattern; LinearRaw files typically store one value (or all equal).
  const black = [
    dng.blackLevel[0] ?? 0,
    dng.blackLevel[1] ?? dng.blackLevel[0] ?? 0,
    dng.blackLevel[2] ?? dng.blackLevel[0] ?? 0,
  ];
  const white = [
    dng.whiteLevel[0] ?? 65535,
    dng.whiteLevel[1] ?? dng.whiteLevel[0] ?? 65535,
    dng.whiteLevel[2] ?? dng.whiteLevel[0] ?? 65535,
  ];
  const scale = white.map((wl, c) => 1 / Math.max(1, wl - black[c]));

  // AsShotNeutral is the camera response to neutral gray; its reciprocal
  // is the channel gain. Missing/degenerate → unity WB.
  const neutral = dng.asShotNeutral;
  const gain = [0, 1, 2].map((c) => {
    const n = neutral?.[c];
    return n && n > 1e-6 ? 1 / n : 1;
  });

  const matrix = pickColorMatrix(dng);
  const m = matrix ? camToSrgbMatrix(matrix) : null;

  const oriented = orientedSize(orientation, w, h);
  const out = new Uint16Array(w * h * 3);

  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 3) {
      let r = Math.min(1, (data[i] - black[0]) * scale[0] * gain[0]);
      let g = Math.min(1, (data[i + 1] - black[1]) * scale[1] * gain[1]);
      let b = Math.min(1, (data[i + 2] - black[2]) * scale[2] * gain[2]);
      if (r < 0) r = 0;
      if (g < 0) g = 0;
      if (b < 0) b = 0;
      let R = r;
      let G = g;
      let B = b;
      if (m) {
        R = m[0] * r + m[1] * g + m[2] * b;
        G = m[3] * r + m[4] * g + m[5] * b;
        B = m[6] * r + m[7] * g + m[8] * b;
        R = R < 0 ? 0 : R > 1 ? 1 : R;
        G = G < 0 ? 0 : G > 1 ? 1 : G;
        B = B < 0 ? 0 : B > 1 ? 1 : B;
      }
      const o = orientIndex(orientation, x, y, w, h) * 3;
      out[o] = (R * 65535 + 0.5) | 0;
      out[o + 1] = (G * 65535 + 0.5) | 0;
      out[o + 2] = (B * 65535 + 0.5) | 0;
    }
  }
  return {
    data: out,
    width: oriented.width,
    height: oriented.height,
    colors: 3,
    bits: 16,
  };
}
