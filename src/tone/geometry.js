// Pure geometry for image orientation (90° turns) and straightening (a
// fine rotation, ±45°). The "frame" is the oriented image: source pixels
// after `orient` quarter-turns clockwise. Straightening rotates the image
// behind the frame and scales it up just enough (coverScale) that the
// frame never shows blank corners, so crop rects — which live in frame UV
// space — need no adjustment when the angle changes. The preview shader
// and the CPU export both sample through frameToSource so they can never
// drift apart.

/** @typedef {{ orient: number, angle: number, flipH: boolean, flipV: boolean }} Geometry
 * orient: quarter-turns clockwise (0–3); angle: degrees, +CW on screen;
 * flipH/flipV: mirror the frame horizontally / vertically. The flip is
 * applied first, in frame space (what the user currently sees), so a flip
 * reads the same no matter how the image is rotated, double-flip is the
 * identity, and flipH+flipV samples the same source pixels as a 180° turn. */

export const ZERO_GEOMETRY = Object.freeze({
  orient: 0,
  angle: 0,
  flipH: false,
  flipV: false,
});

/** @param {Geometry} g */
export function isIdentityGeometry(g) {
  return g.orient === 0 && g.angle === 0 && !g.flipH && !g.flipV;
}

/**
 * Frame (oriented) dimensions for a source of w × h.
 * @param {number} orient
 * @param {number} w
 * @param {number} h
 * @returns {{ width: number, height: number }}
 */
export function orientedDims(orient, w, h) {
  return orient % 2 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Uniform scale that keeps a w × h image, rotated by `angle`, covering its
 * own w × h frame (no blank corners). 1 at angle 0.
 * @param {number} angle degrees
 * @param {number} w frame width
 * @param {number} h frame height
 */
export function coverScale(angle, w, h) {
  const t = (Math.abs(angle) * Math.PI) / 180;
  return Math.cos(t) + Math.sin(t) * Math.max(w / h, h / w);
}

/**
 * Map a point in frame pixel space to source pixel space.
 * @param {Geometry} g
 * @param {number} fx frame x (px)
 * @param {number} fy frame y (px)
 * @param {number} srcW source width (px)
 * @param {number} srcH source height (px)
 * @returns {[number, number]} source x, y (px, unclamped)
 */
export function frameToSource(g, fx, fy, srcW, srcH) {
  const { width: fw, height: fh } = orientedDims(g.orient, srcW, srcH);
  // Flip first, in frame space — mirrors the user's current view, so the
  // flip composes the same way regardless of the 90° turns or straighten
  // that follow.
  if (g.flipH) fx = fw - fx;
  if (g.flipV) fy = fh - fy;
  let qx = fx;
  let qy = fy;
  if (g.angle !== 0) {
    const t = (g.angle * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const inv = 1 / coverScale(g.angle, fw, fh);
    const px = fx - fw / 2;
    const py = fy - fh / 2;
    // inverse of the on-screen CW rotation (y-down coordinates)
    qx = (c * px + s * py) * inv + fw / 2;
    qy = (-s * px + c * py) * inv + fh / 2;
  }
  switch (g.orient & 3) {
    case 1:
      return [qy, srcH - qx];
    case 2:
      return [srcW - qx, srcH - qy];
    case 3:
      return [srcW - qy, qx];
    default:
      return [qx, qy];
  }
}

/** @typedef {{ x: number, y: number, w: number, h: number }} NormRect */

/**
 * Where a normalized frame rect lands after one more quarter-turn
 * clockwise (the rect follows the image content).
 * @param {NormRect} r
 * @returns {NormRect}
 */
export function rotateRectCW(r) {
  return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
}

/**
 * Where a normalized frame rect lands after one quarter-turn
 * counter-clockwise (the rect follows the image content).
 * @param {NormRect} r
 * @returns {NormRect}
 */
export function rotateRectCCW(r) {
  return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
}

/**
 * Map a normalized frame rect back to source UV space, ignoring the
 * straighten angle (good enough for image statistics).
 * @param {number} orient
 * @param {NormRect} r
 * @returns {NormRect}
 */
export function frameRectToSource(orient, r) {
  switch (orient & 3) {
    case 1:
      return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
    case 2:
      return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
    case 3:
      return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
    default:
      return { ...r };
  }
}
