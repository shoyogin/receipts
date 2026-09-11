import { useMemo, useState } from 'react'
import { GREY } from '../lib/colors'
import { nf, pct } from '../lib/format'

const SIZE = 168
const R = 57
const THICK = 23
const C = 2 * Math.PI * R
const GAP = 3            // surface gap between neighbouring slices, in px of arc

/**
 * Part-to-whole at a glance. Slices past `max` fold into one "Other" wedge —
 * a ring with a dozen wedges is a colour-matching puzzle, not a chart, and the
 * table below carries every row anyway.
 */
export default function Donut({ title, caption, data, max = 6, centerLabel }) {
  const [hot, setHot] = useState(-1)

  const { slices, total } = useMemo(() => {
    const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value)
    const total = sorted.reduce((a, d) => a + d.value, 0)
    if (sorted.length <= max) return { slices: sorted, total }
    const head = sorted.slice(0, max - 1)
    const rest = sorted.slice(max - 1)
    return {
      total,
      slices: [...head, {
        key: '__other', label: `Other (${rest.length} classes)`, color: GREY,
        value: rest.reduce((a, d) => a + d.value, 0),
      }],
    }
  }, [data, max])

  let offset = 0
  const arcs = slices.map((s) => {
    const len = (s.value / total) * C
    const arc = { ...s, len: Math.max(len - GAP, 0.6), offset }
    offset += len
    return arc
  })

  const active = hot >= 0 ? arcs[hot] : null

  return (
    <section className="rounded-lg border border-line bg-card p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {caption && <p className="mt-0.5 mb-1 text-xs text-muted">{caption}</p>}

      {total === 0 ? (
        <p className="py-10 text-center text-sm text-muted">Nothing to show yet.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-6">
          <svg
            width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="shrink-0" role="img"
            aria-label={`${title}: ${arcs.map((a) => `${a.label} ${pct(a.value, total)}`).join(', ')}`}
          >
            <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
              {arcs.map((a, i) => (
                <circle
                  key={a.key} cx={SIZE / 2} cy={SIZE / 2} r={R}
                  fill="none"
                  style={{ stroke: a.color, strokeWidth: hot === i ? THICK + 6 : THICK }}
                  strokeDasharray={`${a.len} ${C - a.len}`}
                  strokeDashoffset={-a.offset}
                  onMouseEnter={() => setHot(i)}
                  onMouseLeave={() => setHot(-1)}
                  className="cursor-default transition-[stroke-width] duration-100"
                />
              ))}
            </g>
            <text
              x="50%" y={active ? '46%' : '50%'} textAnchor="middle"
              className="fill-ink num" style={{ fontSize: 20, fontWeight: 600 }}
            >
              {active ? pct(active.value, total) : nf(total)}
            </text>
            <text
              x="50%" y={active ? '58%' : '62%'} textAnchor="middle"
              className="fill-muted" style={{ fontSize: 11 }}
            >
              {active ? active.label : centerLabel}
            </text>
          </svg>

          <ul className="min-w-[210px] flex-1 space-y-0.5">
            {arcs.map((a, i) => (
              <li
                key={a.key}
                onMouseEnter={() => setHot(i)}
                onMouseLeave={() => setHot(-1)}
                className={`flex items-center gap-2.5 rounded px-2 py-1 text-sm ${
                  hot === i ? 'bg-hover' : ''
                }`}
              >
                <span className="size-2.5 shrink-0 rounded-[2px]"
                      style={{ background: a.color }} />
                <span className="flex-1 truncate">{a.label}</span>
                <span className="num font-semibold">{pct(a.value, total)}</span>
                <span className="num w-11 shrink-0 text-right text-xs text-muted">{nf(a.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
