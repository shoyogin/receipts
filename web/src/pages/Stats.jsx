import { useEffect, useMemo, useState } from 'react'
import Donut from '../components/Donut'
import { getSummary } from '../lib/api'
import { GREY, classColor } from '../lib/colors'
import { nf, pct, splitLabel } from '../lib/format'
import { useData } from '../lib/store'

export default function Stats() {
  const { version, stats } = useData()
  const [summary, setSummary] = useState({})

  useEffect(() => {
    if (version) getSummary(version).then(setSummary).catch(() => {})
  }, [version])

  const rows = useMemo(() => {
    if (!stats) return []
    return stats.classes
      .map((name, i) => ({ i, name, value: stats.class_counts[i] || 0 }))
      .sort((a, b) => b.value - a.value)
  }, [stats])

  if (!stats) return <p className="p-8 text-sm text-muted">Loading…</p>

  const boxes = rows.reduce((a, r) => a + r.value, 0)
  const withBoxes = stats.total - stats.unlabeled - stats.empty
  const reviewed = (summary.ok || 0) + (summary.no || 0) + (summary.review || 0)
  const unused = rows.filter((r) => r.value === 0).length
  const used = rows.filter((r) => r.value > 0)
  const ratio = used.length ? used[0].value / used[used.length - 1].value : 0

  const balance = !boxes ? { tone: GREY, text: 'No boxes yet' }
    : unused ? { tone: 'var(--color-no)', text: `${unused} class${unused > 1 ? 'es' : ''} unused` }
    : ratio >= 5 ? { tone: 'var(--color-no)', text: `Imbalanced — ${ratio.toFixed(1)}× spread` }
    : ratio >= 2 ? { tone: 'var(--color-warn)', text: `Mild skew — ${ratio.toFixed(1)}× spread` }
    : { tone: 'var(--color-ok)', text: 'Balanced — under 2× spread' }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Images" value={nf(stats.total)}
                sub={`${nf(stats.unlabeled)} with no label file`} />
          <Tile label="Classes" value={nf(stats.classes.length)}
                sub={unused ? `${nf(unused)} with no boxes` : 'all in use'} />
          <Tile label="Boxes" value={nf(boxes)}
                sub={`${stats.total ? (boxes / stats.total).toFixed(1) : '0'} per image`} />
          <Tile label="Reviewed" value={`${nf(reviewed)} / ${nf(stats.total)}`}
                sub={`${nf(summary.no || 0)} marked not OK`} />
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-lg border border-line bg-card px-5 py-3">
          <span className="size-3 shrink-0 rounded-full" style={{ background: balance.tone }} />
          <div>
            <div className="text-sm font-semibold">Class balance — {version}</div>
            <div className="text-xs text-muted">{balance.text}</div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Donut
            title="Share of every box"
            caption={`All ${nf(boxes)} boxes across every split of ${version}.`}
            centerLabel="boxes"
            data={rows.map((r) => ({
              key: r.i, label: r.name, value: r.value, color: classColor(r.i),
            }))}
          />
          <Donut
            title="Images by label state"
            caption="A label file can exist and still hold no boxes."
            centerLabel="images"
            data={[
              { key: 'boxes', label: 'Has boxes', value: withBoxes, color: classColor(0) },
              { key: 'empty', label: 'Empty label file', value: stats.empty, color: classColor(1) },
              { key: 'none', label: 'No label file', value: stats.unlabeled, color: classColor(2) },
            ]}
          />
          <Donut
            title="Images per split"
            caption="How the version is divided."
            centerLabel="images"
            data={Object.entries(stats.splits).map(([s, n], i) => ({
              key: s, label: splitLabel(s), value: n, color: classColor(i),
            }))}
          />
          <Donut
            title="Review progress"
            caption="Images marked not OK are left out of the reviewed download."
            centerLabel="images"
            data={[
              { key: 'ok', label: 'OK', value: summary.ok || 0, color: 'var(--color-ok)' },
              { key: 'review', label: 'Corrected, waiting', value: summary.review || 0, color: 'var(--color-review-fill)' },
              { key: 'no', label: 'Not OK', value: summary.no || 0, color: 'var(--color-no)' },
              { key: 'todo', label: 'Not reviewed', value: Math.max(stats.total - reviewed, 0), color: GREY },
            ]}
          />
        </div>

        <section className="mt-5 rounded-lg border border-line bg-card p-5">
          <h2 className="text-sm font-semibold">Every class</h2>
          <p className="mt-0.5 mb-3 text-xs text-muted">
            Boxes per class, and how they fall across the splits. This is the full
            list — the chart above folds the small classes into one slice.{' '}
            {stats.class_source
              ? <>Names come from <code className="text-ink2">{stats.class_source}</code>.</>
              : <>No <code className="text-ink2">classes.txt</code> or{' '}
                 <code className="text-ink2">data.yaml</code> in this version, so the
                 classes are numbered as the label files have them.</>}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-lg border-collapse text-sm">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="border-b border-rule py-1.5 pr-3 text-left font-medium">class</th>
                  <th className="border-b border-rule py-1.5 pr-3 text-right font-medium">boxes</th>
                  <th className="border-b border-rule py-1.5 pr-3 text-right font-medium">share</th>
                  {Object.keys(stats.splits).map((s) => (
                    <th key={s} className="border-b border-rule py-1.5 pr-3 text-right font-medium">
                      {splitLabel(s)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.i} className={r.value ? '' : 'text-muted'}>
                    <td className="border-b border-line py-1.5 pr-3">
                      <span className="mr-2 inline-block size-2.5 rounded-[2px] align-middle"
                            style={{ background: classColor(r.i) }} />
                      {r.name}
                    </td>
                    <td className="num border-b border-line py-1.5 pr-3 text-right">{nf(r.value)}</td>
                    <td className="num border-b border-line py-1.5 pr-3 text-right font-semibold">
                      {pct(r.value, boxes)}
                    </td>
                    {Object.keys(stats.splits).map((s) => (
                      <td key={s} className="num border-b border-line py-1.5 pr-3 text-right text-muted">
                        {nf(stats.split_class_counts?.[s]?.[r.i] || 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}

const Tile = ({ label, value, sub }) => (
  <div className="rounded-lg border border-line bg-card px-4 py-3">
    <div className="text-xs text-ink2">{label}</div>
    <div className="num mt-0.5 text-2xl font-semibold tracking-tight">{value}</div>
    <div className="mt-0.5 text-[11px] text-muted">{sub}</div>
  </div>
)
