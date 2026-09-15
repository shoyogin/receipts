import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BoxOverlay from '../components/BoxOverlay'
import {
  addComment, deleteComment, folderZipUrl, getItems, getSummary, imgUrl,
  reviewCsvUrl, saveFlag,
} from '../lib/api'
import { classColor } from '../lib/colors'
import { bytes, nf, splitLabel, when } from '../lib/format'
import { useData } from '../lib/store'

const SHOW = [
  ['all', 'All images'],
  ['unreviewed', 'Not reviewed yet'],
  ['ok', 'Marked OK'],
  ['no', 'Marked not OK'],
  ['commented', 'Has comments'],
  ['unlabeled', 'Missing label file'],
  ['empty', 'Label file, no boxes'],
]
const PAGE = 120

export default function Review() {
  const { version, stats, meta } = useData()
  const classes = stats?.classes ?? []

  const [split, setSplit] = useState('')
  const [mode, setMode] = useState('all')
  const [cls, setCls] = useState(() => new Set())
  const [matchAll, setMatchAll] = useState(false)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState(true)
  const [summary, setSummary] = useState({})
  const [open, setOpen] = useState(-1)
  const [who, setWho] = useState(() => localStorage.getItem('reviewer') || '')

  const splits = useMemo(() => Object.keys(stats?.splits ?? {}), [stats])

  useEffect(() => {
    if (!splits.length) return
    setSplit((s) => (splits.includes(s) ? s : splits.includes('train') ? 'train' : splits[0]))
  }, [splits])

  useEffect(() => { setCls(new Set()) }, [version])
  useEffect(() => { if (meta?.user) setWho(meta.user) }, [meta])

  const load = useCallback(async (offset = 0) => {
    if (!version || !split) return
    setBusy(true)
    try {
      const d = await getItems({
        v: version, split, mode, cls: [...cls].join(','),
        clsmode: matchAll ? 'all' : 'any', offset, limit: PAGE,
      })
      setTotal(d.total)
      setItems((prev) => (offset ? [...prev, ...d.items] : d.items))
    } finally {
      setBusy(false)
    }
  }, [version, split, mode, cls, matchAll])

  useEffect(() => { load(0) }, [load])

  const reloadSummary = useCallback(() => {
    if (version) getSummary(version).then(setSummary).catch(() => {})
  }, [version])
  useEffect(reloadSummary, [reloadSummary])

  const toggleClass = (i) => setCls((prev) => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })

  // A verdict updates the one card in place — re-fetching the page would make
  // the image you just judged jump out from under the cursor.
  const applyFlag = useCallback((name, flag) => {
    setItems((prev) => prev.map((it) => (it.name === name ? { ...it, flag } : it)))
    reloadSummary()
  }, [reloadSummary])

  const done = (summary.ok || 0) + (summary.no || 0)

  return (
    <div className="flex h-full">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-line bg-surface p-4">
        <Group label="Split">
          <div className="flex flex-wrap gap-1.5">
            {splits.map((s) => (
              <button
                key={s} onClick={() => setSplit(s)}
                className={`flex-1 rounded-md border px-2 py-1.5 text-xs ${
                  s === split ? 'border-ink bg-ink font-semibold text-page'
                              : 'border-rule bg-card hover:bg-hover'}`}
              >
                {splitLabel(s)} <span className="num opacity-65">{stats.splits[s]}</span>
              </button>
            ))}
          </div>
        </Group>

        <Group label="Show">
          <select
            value={mode} onChange={(e) => setMode(e.target.value)}
            className="w-full rounded-md border border-rule bg-card px-2 py-1.5 text-sm"
          >
            {SHOW.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Group>

        <Group
          label="Classes"
          right={
            <>
              <button
                onClick={() => setMatchAll((v) => !v)}
                title="Any: the image has at least one ticked class. All: it has every one."
                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                  matchAll ? 'border-ink bg-ink text-page' : 'border-rule bg-card text-ink2'}`}
              >
                {matchAll ? 'all' : 'any'}
              </button>
              <button
                onClick={() => setCls(new Set())}
                className="rounded-full border border-rule bg-card px-2 py-0.5 text-[11px] text-ink2"
              >
                clear
              </button>
            </>
          }
        >
          <ul className="-mx-1.5 max-h-[38vh] overflow-y-auto">
            {classes.map((name, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-hover">
                  <input
                    type="checkbox" checked={cls.has(i)} onChange={() => toggleClass(i)}
                    className="size-4 accent-brand"
                  />
                  <span className="size-2.5 rounded-[2px]" style={{ background: classColor(i) }} />
                  <span className="flex-1 truncate text-sm">{name}</span>
                  <span className="num text-xs text-muted">
                    {nf(stats.class_counts[i] || 0)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </Group>

        <div className="mt-5 space-y-1 border-t border-line pt-4 text-sm">
          <Fact label="Reviewed" value={`${nf(done)} / ${nf(stats?.total || 0)}`} />
          <Fact label="OK" value={nf(summary.ok || 0)} />
          <Fact label="Not OK" value={nf(summary.no || 0)} accent="text-no" />
        </div>

        <div className="mt-4 space-y-2">
          <a
            href={folderZipUrl(version, true)} download
            title="The whole version, minus every image marked not OK and its label file"
            className="block rounded-md bg-ink px-3 py-2 text-center text-sm font-semibold text-page hover:opacity-90"
          >
            Download reviewed dataset
            {summary.no ? <span className="font-normal opacity-80"> — {nf(summary.no)} left out</span> : null}
          </a>
          <a
            href={reviewCsvUrl(version)} download
            className="block rounded-md border border-rule bg-card px-3 py-2 text-center text-sm hover:bg-hover"
          >
            Download review.csv
          </a>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-5 py-2.5 text-sm">
          <strong>{version} · {splitLabel(split)}</strong>
          <span className="num text-muted">{nf(items.length)} of {nf(total)}</span>
          {busy && <span className="text-muted">loading…</span>}
          <span className="flex-1" />
          {cls.size > 0 && (
            <span className="text-xs text-muted">
              {cls.size} class{cls.size > 1 ? 'es' : ''} · {matchAll ? 'all of them' : 'any of them'}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {total === 0 && !busy ? (
            <p className="py-20 text-center text-sm text-muted">
              Nothing matches. Try another split or clear the class filter.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
              {items.map((it, i) => (
                <Card key={it.name} item={it} classes={classes}
                      version={version} split={split} onOpen={() => setOpen(i)} />
              ))}
            </div>
          )}
          {items.length < total && (
            <button
              onClick={() => load(items.length)}
              className="mx-auto mt-5 block rounded-md border border-rule bg-card px-4 py-2 text-sm hover:bg-hover"
            >
              Load {nf(Math.min(PAGE, total - items.length))} more
            </button>
          )}
        </div>
      </section>

      {open >= 0 && items[open] && (
        <Viewer
          items={items} index={open} classes={classes} version={version} split={split}
          who={who} setWho={setWho} proxyUser={meta?.user}
          onIndex={setOpen} onClose={() => setOpen(-1)} onFlag={applyFlag}
        />
      )}
    </div>
  )
}

function Group({ label, right, children }) {
  return (
    <div className="mb-5">
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-ink2">
        <span>{label}</span>
        <span className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  )
}

const Fact = ({ label, value, accent }) => (
  <div className="flex justify-between text-ink2">
    <span>{label}</span>
    <b className={`num font-semibold ${accent || 'text-ink'}`}>{value}</b>
  </div>
)

function StatusPill({ status }) {
  if (!status) return null
  const ok = status === 'ok'
  return (
    <span className={`absolute right-1.5 top-1.5 z-2 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
      ok ? 'bg-ok-fill text-ok-ink' : 'bg-no-fill text-no-ink'}`}>
      {ok ? 'OK' : 'not OK'}
    </span>
  )
}

/** Small speech bubble. Drawn rather than set in type: the caption line is
 *  already carrying a filename and a count, and a glyph reads faster there. */
const Bubble = ({ className = '' }) => (
  <svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor"
       strokeWidth="1.1" strokeLinejoin="round"
       className={`size-3 shrink-0 ${className}`}>
    <path d="M1.8 2.2h8.4v5.4H5.4L3 9.8V7.6H1.8z" />
  </svg>
)

function Card({ item, classes, version, split, onOpen }) {
  const status = item.flag?.status
  const notes = item.flag?.comments?.length || 0
  return (
    <figure
      onClick={onOpen}
      className={`relative m-0 cursor-pointer rounded-lg border bg-card ${
        status === 'no' ? 'border-no/40' : 'border-line hover:border-rule'}`}
    >
      <StatusPill status={status} />
      <div className="flex h-40 items-center justify-center overflow-hidden rounded-t-lg bg-stage">
        <div className={status === 'no' ? 'flex max-h-full max-w-full opacity-45' : 'flex max-h-full max-w-full'}>
          <BoxOverlay
            src={imgUrl(version, split, item.name, true)} alt={item.name}
            dim={item.dim} boxes={item.boxes} classes={classes}
          />
        </div>
      </div>
      <figcaption className={`flex items-center justify-between gap-2 rounded-b-lg border-t border-line px-2.5 py-1.5 text-xs ${
        status === 'ok' ? 'shadow-[inset_3px_0_0_var(--color-ok)]'
        : status === 'no' ? 'shadow-[inset_3px_0_0_var(--color-no)]' : ''}`}>
        <span className="truncate text-ink2">{item.name}</span>
        {notes > 0 && (
          <span className="num flex shrink-0 items-center gap-1 text-muted"
                title={`${notes} comment${notes === 1 ? '' : 's'}`}>
            <Bubble />{notes}
          </span>
        )}
        {item.labeled
          ? <span className="num shrink-0 text-muted">{item.boxes.length} box{item.boxes.length === 1 ? '' : 'es'}</span>
          : <span className="shrink-0 font-medium text-no">no label</span>}
      </figcaption>
    </figure>
  )
}

function Viewer({ items, index, classes, version, split, who, setWho, proxyUser,
                  onIndex, onClose, onFlag }) {
  const item = items[index]
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const composeRef = useRef(null)

  useEffect(() => {
    setError('')
    setSaved(item.flag?.status
      ? `${item.flag.reviewer || 'anon'} · ${when(item.flag.ts)}` : '')
  }, [item])

  const status = item.flag?.status

  const commit = useCallback(async (verdict) => {
    setError('')
    try {
      const flag = await saveFlag({
        v: version, split, image: item.name, status: verdict, reviewer: who.trim(),
      })
      onFlag(item.name, flag)
      setSaved(`${flag.reviewer || 'anon'} · ${when(flag.ts)}`)
      // Keep moving on an OK; a rejection wants its reason typed first.
      if (verdict === 'ok' && index < items.length - 1) onIndex(index + 1)
      else if (verdict === 'no') composeRef.current?.focus()
    } catch (e) {
      setError(e.message)
    }
  }, [version, split, item, who, index, items.length, onFlag, onIndex])

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.matches('textarea, input')) {
        if (e.key === 'Escape') e.target.blur()
        return
      }
      if (e.key === 'Escape') onClose()
      if (e.key === '1') { e.preventDefault(); commit('ok') }
      if (e.key === '2') { e.preventDefault(); commit('no') }
      if (e.key === 'ArrowRight') onIndex(Math.min(index + 1, items.length - 1))
      if (e.key === 'ArrowLeft') onIndex(Math.max(index - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commit, index, items.length, onIndex, onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
         onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="grid max-h-[94vh] w-full max-w-6xl grid-cols-1 overflow-hidden rounded-xl bg-surface md:grid-cols-[1fr_320px]"
      >
        <div className="flex min-h-0 items-center justify-center bg-stage p-2">
          <BoxOverlay
            src={imgUrl(version, split, item.name)} alt={item.name} big
            dim={item.dim} boxes={item.boxes} classes={classes} tagMin={[0.05, 0.03]}
          />
        </div>

        <div className="min-h-0 overflow-y-auto border-l border-line bg-card p-4">
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 break-all text-sm font-semibold">{item.name}</h2>
            <button onClick={onClose}
                    className="rounded border border-line px-2 py-0.5 text-xs text-ink2 hover:bg-hover">
              esc
            </button>
          </div>

          <div className="mt-3 space-y-1 text-sm text-ink2">
            <Fact label="Boxes" value={item.labeled ? nf(item.boxes.length) : 'no label file'} />
            <Fact label="File size" value={bytes(item.size)} />
            {item.dim && <Fact label="Pixels" value={`${item.dim[0]} × ${item.dim[1]}`} />}
          </div>

          {item.boxes.length > 0 && (
            <table className="mt-3 w-full border-collapse text-xs">
              <thead>
                <tr className="text-muted">
                  {['class', 'x', 'y', 'w', 'h'].map((h) => (
                    <th key={h} className="border-b border-rule py-1 pr-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {item.boxes.map(([c, ...rest], i) => (
                  <tr key={i}>
                    <td className="border-b border-line py-1 pr-2">
                      <span className="mr-1.5 inline-block size-2.5 rounded-[2px] align-middle"
                            style={{ background: classColor(c) }} />
                      {classes[c] ?? c}
                    </td>
                    {rest.map((v, j) => (
                      <td key={j} className="num border-b border-line py-1 pr-2">{v.toFixed(3)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="mt-5 border-t border-line pt-4">
            <h3 className="mb-2 text-xs font-medium text-ink2">Is this label correct?</h3>
            <div className="flex gap-2">
              <button
                onClick={() => commit('ok')}
                className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                  status === 'ok' ? 'border-ok-fill bg-ok-fill font-semibold text-ok-ink'
                                  : 'border-rule bg-card hover:bg-hover'}`}
              >
                OK
              </button>
              <button
                onClick={() => commit('no')}
                className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                  status === 'no' ? 'border-no-fill bg-no-fill font-semibold text-no-ink'
                                  : 'border-rule bg-card hover:bg-hover'}`}
              >
                Not OK
              </button>
            </div>

            <p className={`mt-2 min-h-4 text-[11px] ${error ? 'text-no' : 'text-muted'}`}>
              {error || saved}
            </p>

            {proxyUser == null && (
              <label className="mt-2 flex items-center gap-2 text-xs text-ink2">
                Reviewer
                <input
                  value={who}
                  onChange={(e) => { setWho(e.target.value); localStorage.setItem('reviewer', e.target.value.trim()) }}
                  placeholder="your name"
                  className="flex-1 rounded-md border border-rule bg-card px-2 py-1 text-xs"
                />
              </label>
            )}
            <Thread
              key={item.name} item={item} version={version} split={split}
              who={who} boxRef={composeRef} onFlag={onFlag}
            />

          </div>

          <div className="mt-4 flex items-center gap-2 text-[11px] text-muted">
            <button onClick={() => onIndex(Math.max(index - 1, 0))}
                    className="rounded border border-line px-2 py-0.5 hover:bg-hover">←</button>
            <button onClick={() => onIndex(Math.min(index + 1, items.length - 1))}
                    className="rounded border border-line px-2 py-0.5 hover:bg-hover">→</button>
            <span>move · <b>1</b> OK · <b>2</b> not OK · <b>esc</b> close</span>
          </div>
        </div>
      </div>
    </div>
  )
}


/** Every comment left on one image, oldest first, plus the box to add another.
 *  Comments are independent of the verdict — an image can collect a question
 *  from one reviewer and an answer from the next without anyone judging it. */
function Thread({ item, version, split, who, boxRef, onFlag }) {
  const comments = item.flag?.comments ?? []
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const me = who.trim() || 'anon'

  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    setError('')
    try {
      onFlag(item.name, await addComment({
        v: version, split, image: item.name, text: body, reviewer: who.trim(),
      }))
      setText('')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id) => {
    setError('')
    try {
      onFlag(item.name, await deleteComment({
        v: version, split, image: item.name, id, reviewer: who.trim(),
      }))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ink2">
        <Bubble />
        Comments {comments.length > 0 && <span className="num">({comments.length})</span>}
      </h3>

      {comments.length === 0 ? (
        <p className="text-[11px] text-muted">None yet.</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-md border border-line bg-page px-2.5 py-1.5">
              <div className="flex items-baseline gap-2 text-[11px] text-muted">
                <b className="font-semibold text-ink2">{c.reviewer || 'anon'}</b>
                <span className="num">{when(c.ts)}</span>
                <span className="flex-1" />
                {(c.reviewer || 'anon') === me && (
                  <button
                    onClick={() => remove(c.id)} title="Delete this comment"
                    className="rounded px-1 leading-none hover:bg-hover hover:text-no"
                  >
                    ×
                  </button>
                )}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{c.text}</p>
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={boxRef} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter alone has to stay a newline: these run to several lines.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
        }}
        placeholder="box is off, wrong class, blurred…"
        className="mt-2 min-h-[58px] w-full resize-y rounded-md border border-rule bg-card p-2 text-sm"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={send} disabled={busy || !text.trim()}
          className="rounded-md border border-rule bg-card px-2.5 py-1 text-xs hover:bg-hover disabled:opacity-45"
        >
          {busy ? 'Saving…' : 'Add comment'}
        </button>
        <span className="text-[11px] text-muted">⌘↵ / ctrl↵</span>
      </div>

      {error && <p className="mt-1 text-[11px] text-no">{error}</p>}
      <p className="mt-2 text-[11px] text-muted">
        Every comment on an image marked not OK travels with it into EXCLUDED.csv.
      </p>
    </div>
  )
}
