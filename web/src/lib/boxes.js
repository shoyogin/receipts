/* Box geometry, kept away from React so the awkward part can be reasoned about
   (and tested) on its own.

   Two representations, and everything here exists to move between them:

     YOLO  [cls, xc, yc, w, h]   centre and size, 0…1 of the image
     Rect  {x0, y0, x1, y1}      corners, 0…1, x0 <= x1

   Dragging is natural in corners — you hold one and move the other — and the
   dataset speaks centres, so a resize is corner-in, corner-out, YOLO at rest. */

export const MIN_SIDE = 0.002        // matches the server's floor
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

export const toRect = ([, x, y, w, h]) => ({
  x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2,
})

/** Corners back to a YOLO row, normalised so a drag that crossed over itself
 *  still yields a positive size, then clamped onto the image. */
export function toBox(cls, { x0, y0, x1, y1 }) {
  const left = clamp01(Math.min(x0, x1))
  const top = clamp01(Math.min(y0, y1))
  const right = clamp01(Math.max(x0, x1))
  const bottom = clamp01(Math.max(y0, y1))
  const w = Math.max(right - left, MIN_SIDE)
  const h = Math.max(bottom - top, MIN_SIDE)
  return [cls, left + w / 2, top + h / 2, w, h]
}

/** Slide a box without letting it leave the image or change size — the offset
 *  is trimmed to what will fit, so a box dragged at the edge stops rather than
 *  squashing. */
export function moveBox([cls, x, y, w, h], dx, dy) {
  return [cls,
    Math.min(Math.max(x + dx, w / 2), 1 - w / 2),
    Math.min(Math.max(y + dy, h / 2), 1 - h / 2), w, h]
}

/** The eight handles, as fractions of the box. Corners first: those are the
 *  ones people reach for, and hit-testing walks this in order. */
export const HANDLES = [
  { id: 'nw', fx: 0, fy: 0, cursor: 'nwse-resize' },
  { id: 'ne', fx: 1, fy: 0, cursor: 'nesw-resize' },
  { id: 'se', fx: 1, fy: 1, cursor: 'nwse-resize' },
  { id: 'sw', fx: 0, fy: 1, cursor: 'nesw-resize' },
  { id: 'n', fx: 0.5, fy: 0, cursor: 'ns-resize' },
  { id: 'e', fx: 1, fy: 0.5, cursor: 'ew-resize' },
  { id: 's', fx: 0.5, fy: 1, cursor: 'ns-resize' },
  { id: 'w', fx: 0, fy: 0.5, cursor: 'ew-resize' },
]

/** Drag one handle to (px, py). The opposite edges stay put; a handle dragged
 *  past them flips the box rather than inverting it, which is what every
 *  drawing tool does and what the hand expects. */
export function resizeBox(box, handle, px, py) {
  const r = toRect(box)
  // An edge handle moves one axis only, which is why this tests the letters
  // rather than the handle as a whole: "n" touches y, "nw" touches both.
  if (handle.includes('n')) r.y0 = py
  if (handle.includes('s')) r.y1 = py
  if (handle.includes('w')) r.x0 = px
  if (handle.includes('e')) r.x1 = px
  return toBox(box[0], r)
}

/** Topmost box under the point, or -1. Later boxes are drawn on top, so the
 *  search runs backwards: what you see is what you grab. */
export function hitBox(boxes, x, y) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const r = toRect(boxes[i])
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return i
  }
  return -1
}

/** Which handle of `box` is under the point, or null. `pad` is the grab radius
 *  in image fractions — the caller converts it from pixels, so the target stays
 *  the same physical size however the image is scaled. */
export function hitHandle(box, x, y, pad) {
  const r = toRect(box)
  for (const h of HANDLES) {
    const hx = r.x0 + (r.x1 - r.x0) * h.fx
    const hy = r.y0 + (r.y1 - r.y0) * h.fy
    if (Math.abs(x - hx) <= pad && Math.abs(y - hy) <= pad) return h
  }
  return null
}

/** True when two box lists differ — what the editor's "unsaved changes" and
 *  its save button both key off. Rounded, because a drag that lands a pixel
 *  away and back is not an edit. */
export function boxesEqual(a, b) {
  if (a.length !== b.length) return false
  const r = (v) => Math.round(v * 1e6)
  return a.every((box, i) =>
    box[0] === b[i][0] && box.slice(1).every((v, j) => r(v) === r(b[i][j + 1])))
}
