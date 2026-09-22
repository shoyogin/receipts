import { useCallback, useEffect, useRef, useState } from 'react'
import { classColor, classInk } from '../lib/colors'
import {
  HANDLES, hitBox, hitHandle, moveBox, resizeBox, toBox, toRect,
} from '../lib/boxes'

const GRAB = 9        // handle grab radius, in screen pixels

/**
 * The image with its boxes, editable.
 *
 * BoxOverlay stays what it is — the read-only drawing used on cards and in the
 * viewer. This is its own component because interaction changes everything
 * about the markup: every box needs a hit area and eight handles, and the
 * frame needs to own the pointer.
 *
 * All geometry is normalised against the frame's own rectangle, so the editor
 * is correct at any size and the boxes never need to know how big the image is
 * being displayed.
 */
export default function BoxEditor({
  src, alt, dim, boxes, classes, cls, selected, onSelect, onChange,
}) {
  const frame = useRef(null)
  const [drag, setDrag] = useState(null)
  const [hover, setHover] = useState(null)

  /** Pointer position as a fraction of the image. */
  const at = useCallback((e) => {
    const r = frame.current.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height,
             pad: GRAB / r.width }
  }, [])

  const onPointerDown = (e) => {
    if (e.button !== 0) return
    const { x, y, pad } = at(e)
    e.currentTarget.setPointerCapture(e.pointerId)

    // A handle on the selected box wins over everything: it sits on the
    // boundary, where a plain hit test would read as the box behind it.
    if (selected >= 0 && boxes[selected]) {
      const h = hitHandle(boxes[selected], x, y, pad)
      if (h) {
        return setDrag({ kind: 'resize', handle: h.id, i: selected,
                         start: boxes[selected] })
      }
    }
    const i = hitBox(boxes, x, y)
    if (i >= 0) {
      onSelect(i)
      // The box as it was when the drag began, plus the total offset since.
      // Deriving each frame from the last would drift whenever a pointermove
      // outruns a render — which it does, on a trackpad.
      return setDrag({ kind: 'move', i, x0: x, y0: y, start: boxes[i] })
    }
    // Empty space: start drawing. The box is created at zero size and grows
    // with the drag, so a click that never moves leaves nothing behind.
    onSelect(-1)
    setDrag({ kind: 'draw', x0: x, y0: y, x, y })
  }

  const onPointerMove = (e) => {
    const { x, y, pad } = at(e)
    if (!drag) {
      const h = selected >= 0 && boxes[selected]
        ? hitHandle(boxes[selected], x, y, pad) : null
      return setHover(h ? h.cursor : hitBox(boxes, x, y) >= 0 ? 'move' : 'crosshair')
    }
    if (drag.kind === 'draw') return setDrag({ ...drag, x, y })
    const next = boxes.slice()
    next[drag.i] = drag.kind === 'move'
      ? moveBox(drag.start, x - drag.x0, y - drag.y0)
      : resizeBox(drag.start, drag.handle, x, y)
    // Every frame of the gesture replaces the last on the undo stack, so one
    // drag is one step back rather than a hundred.
    onChange(next, { quiet: true })
  }

  const onPointerUp = (e) => {
    if (!drag) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (drag.kind === 'draw') {
      // Anything smaller than the grab radius was a click, not a drawing.
      const r = frame.current.getBoundingClientRect()
      const tiny = Math.abs(drag.x - drag.x0) * r.width < GRAB &&
                   Math.abs(drag.y - drag.y0) * r.height < GRAB
      if (!tiny) {
        const next = [...boxes,
          toBox(cls, { x0: drag.x0, y0: drag.y0, x1: drag.x, y1: drag.y })]
        onChange(next)
        onSelect(next.length - 1)
      }
    }
    setDrag(null)
  }

  // Draw the in-flight rectangle from the drag, everything else from state.
  const drawing = drag?.kind === 'draw'
    ? toRect(toBox(cls, { x0: drag.x0, y0: drag.y0, x1: drag.x, y1: drag.y }))
    : null

  return (
    <div
      ref={frame}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => !drag && setHover(null)}
      className="relative max-h-full max-w-full touch-none select-none"
      style={{
        aspectRatio: dim ? `${dim[0]} / ${dim[1]}` : '4 / 3',
        cursor: drag ? 'grabbing' : hover || 'crosshair',
      }}
    >
      <img src={src} alt={alt} draggable={false} className="block size-full" />

      {boxes.map((box, i) => {
        const r = toRect(box)
        const on = i === selected
        return (
          <div
            key={i}
            className="absolute rounded-[2px] border-2"
            style={{
              borderColor: classColor(box[0]),
              left: `${r.x0 * 100}%`,
              top: `${r.y0 * 100}%`,
              width: `${(r.x1 - r.x0) * 100}%`,
              height: `${(r.y1 - r.y0) * 100}%`,
              // The selected box gains a ring instead of changing colour: its
              // hue is its class, and losing that to show selection would make
              // the one box you are working on the one you cannot identify.
              boxShadow: on
                ? '0 0 0 1px var(--color-page), 0 0 0 3px var(--color-ink)'
                : '0 0 0 1px rgba(255,255,255,.65)',
            }}
          >
            <span
              className="pointer-events-none absolute -left-0.5 -top-0.5 rounded-[2px] px-1 text-[11px] font-semibold whitespace-nowrap"
              style={{ background: classColor(box[0]), color: classInk(box[0]) }}
            >
              {classes[box[0]] ?? box[0]}
            </span>
            {on && HANDLES.map((h) => (
              <span
                key={h.id}
                className="absolute size-2.5 rounded-[2px] border border-ink bg-page"
                style={{
                  left: `${h.fx * 100}%`, top: `${h.fy * 100}%`,
                  transform: 'translate(-50%, -50%)', cursor: h.cursor,
                }}
              />
            ))}
          </div>
        )
      })}

      {drawing && (
        <div
          className="pointer-events-none absolute rounded-[2px] border-2 border-dashed"
          style={{
            borderColor: classColor(cls),
            left: `${drawing.x0 * 100}%`,
            top: `${drawing.y0 * 100}%`,
            width: `${(drawing.x1 - drawing.x0) * 100}%`,
            height: `${(drawing.y1 - drawing.y0) * 100}%`,
          }}
        />
      )}
    </div>
  )
}

/** Boxes with an undo stack. Kept beside the editor because undo is a property
 *  of the editing session, not of the component that draws rectangles.
 *
 *  A drag calls back on every pointer move; those arrive `quiet` and replace
 *  the top of the stack instead of pushing onto it, so one gesture is one step
 *  back and ⌘Z does not crawl through a hundred intermediate positions. */
export function useBoxHistory(initial, key) {
  const [stack, setStack] = useState([initial])
  const [at, setAt] = useState(0)

  // Keyed on the image, not on the array: a parent that rebuilds its props on
  // every render would otherwise wipe the history continuously.
  useEffect(() => { setStack([initial]); setAt(0) }, [key])   // eslint-disable-line react-hooks/exhaustive-deps

  const boxes = stack[at]
  const set = useCallback((next, { quiet } = {}) => {
    setStack((s) => {
      const kept = s.slice(0, at + 1)
      if (quiet && kept.length > 1) return [...kept.slice(0, -1), next]
      return [...kept, next]
    })
    setAt((i) => (quiet && i > 0 ? i : i + 1))
  }, [at])

  return {
    boxes, set,
    undo: () => setAt((i) => Math.max(i - 1, 0)),
    redo: () => setAt((i) => Math.min(i + 1, stack.length - 1)),
    canUndo: at > 0,
    canRedo: at < stack.length - 1,
    reset: (next) => { setStack([next]); setAt(0) },
  }
}
