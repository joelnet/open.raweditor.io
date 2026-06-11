// Pure geometry for the crop tool, in display-pixel space. The canvas is
// drawn at the image's pixel aspect, so an aspect ratio expressed in
// display px is the same number as in image px. All functions clamp the
// result into [0, bw] × [0, bh]; pure so it's node:test-able.

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Translate a rect by (dx, dy), clamped inside the bounds.
 * @param {Rect} start
 * @param {number} dx
 * @param {number} dy
 * @param {number} bw
 * @param {number} bh
 * @returns {Rect}
 */
export function moveRect(start, dx, dy, bw, bh) {
  return {
    x: clamp(start.x + dx, 0, bw - start.w),
    y: clamp(start.y + dy, 0, bh - start.h),
    w: start.w,
    h: start.h,
  };
}

/**
 * Resize a rect by dragging one of its eight handles. With an aspect
 * (w/h) the rect stays locked to it: corner drags anchor the opposite
 * corner, edge drags keep the other axis centered on its original
 * midline.
 * @param {Rect} start
 * @param {string} handle nw | n | ne | e | se | s | sw | w
 * @param {number} dx
 * @param {number} dy
 * @param {number} bw
 * @param {number} bh
 * @param {number | null} aspect locked w/h, or null for freeform
 * @param {number} [min] minimum edge length
 * @returns {Rect}
 */
export function resizeRect(start, handle, dx, dy, bw, bh, aspect, min = 1) {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");

  let left = start.x + (west ? dx : 0);
  let right = start.x + start.w + (east ? dx : 0);
  let top = start.y + (north ? dy : 0);
  let bottom = start.y + start.h + (south ? dy : 0);
  if (west) left = clamp(left, 0, right - min);
  if (east) right = clamp(right, left + min, bw);
  if (north) top = clamp(top, 0, bottom - min);
  if (south) bottom = clamp(bottom, top + min, bh);

  if (aspect) {
    if ((west || east) && (north || south)) {
      // corner: largest aspect-true rect within the drag, anchored to the
      // opposite corner; shrink uniformly if the bounds cut it off
      let w = right - left;
      let h = bottom - top;
      if (w / h > aspect) w = h * aspect;
      else h = w / aspect;
      const maxW = west ? right : bw - left;
      const maxH = north ? bottom : bh - top;
      const fit = Math.min(maxW / w, maxH / h, 1);
      w *= fit;
      h *= fit;
      if (west) left = right - w;
      else right = left + w;
      if (north) top = bottom - h;
      else bottom = top + h;
    } else if (west || east) {
      const cy = start.y + start.h / 2;
      let w = right - left;
      let h = w / aspect;
      const maxH = 2 * Math.min(cy, bh - cy);
      if (h > maxH) {
        h = maxH;
        w = h * aspect;
        if (west) left = right - w;
        else right = left + w;
      }
      top = cy - h / 2;
      bottom = cy + h / 2;
    } else {
      const cx = start.x + start.w / 2;
      let h = bottom - top;
      let w = h * aspect;
      const maxW = 2 * Math.min(cx, bw - cx);
      if (w > maxW) {
        w = maxW;
        h = w / aspect;
        if (north) top = bottom - h;
        else bottom = top + h;
      }
      left = cx - w / 2;
      right = cx + w / 2;
    }
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Largest rect of the given aspect that fits inside `rect`, sharing its
 * center (then clamped into the bounds).
 * @param {Rect} rect
 * @param {number} aspect w/h
 * @param {number} bw
 * @param {number} bh
 * @returns {Rect}
 */
export function fitAspect(rect, aspect, bw, bh) {
  let w = rect.w;
  let h = rect.h;
  if (w / h > aspect) w = h * aspect;
  else h = w / aspect;
  return {
    x: clamp(rect.x + (rect.w - w) / 2, 0, bw - w),
    y: clamp(rect.y + (rect.h - h) / 2, 0, bh - h),
    w,
    h,
  };
}
