import { useCallback, useEffect, useMemo, useState } from 'react'
import BoxEditor, { useBoxHistory } from '../components/BoxEditor'
import { getQueue, imgUrl, revertLabels, saveFlag, saveLabels } from '../lib/api'
import { boxesEqual } from '../lib/boxes'
import { classColor } from '../lib/colors'
import { nf, splitLabel, when } from '../lib/format'
import { useData } from '../lib/store'

/**
 * The repair bench: every image review turned down, with its boxes editable.
 *
 * Saving a redraw does not pass a verdict — the server moves the image to
 * "review" and it waits there for somebody else to accept it. That is the whole
 * point of the tab, so the accept button lives on Review, not here.
 */
export default function Fix() {
  const { version, stats, meta } = useData()
  const classes = stats?.classes ?? []
  const me = meta?.user || ''

  const [queue, setQueue] = useState([])
  const [busy, setBusy] = useState(true)
  const [openAt, setOpenAt] = useState(0)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!version) return
    setBusy(true)
    try {
      const d = await getQueue(version)
      setQueue(d.items)
      setOpenAt((i) => Math.min(i, Math.max(d.items.length - 1, 0)))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [version])

  useEffect(() => { load() }, [load])

  const item = queue[openAt]

  const replace = useCallback((name, split, patch) => {
    setQueue((q) => q.map((it) =>
      (it.name === name && it.split === split ? { ...it, ...patch } : it)))
  }, [])

  if (!version) return <p className="p-8 text-sm text-muted">No version selected.</p>

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 overflow-y-auto border-r border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <h1 className="text-sm font-semibold">Needs fixing</h1>
          <p className="mt-0.5 text-xs text-muted">
            {busy ? 'Loading…' : `${nf(queue.length)} in ${version}`}
          </p>
        </div>
        {queue.length === 0 && !busy ? (
          <p className="px-4 py-6 text-sm text-muted">
            Nothing to fix. Images marked not OK on Review land here.
          </p>
        ) : (
          <ul>
            {queue.map((it, i) => (
              <li key={`${it.split}/${it.name}`}>
                <button
                  onClick={() => setOpenAt(i)}
                  className={`flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-xs ${
                    i === openAt ? 'bg-hover font-semibold' : 'hover:bg-hover'}`}
                >
                  <span className="size-2 shrink-0 rounded-full"
                        style={{ background: it.flag?.status === 'review'
                          ? 'var(--color-review-fill)' : 'var(--color-no)' }} />
                  <span className="min-w-0 flex-1 truncate">{it.name}</span>
                  <span className="shrink-0 text-muted">{splitLabel(it.split)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {item ? (
        <Bench
          key={`${item.split}/${item.name}`} item={item} version={version}
          classes={classes} me={me} onPatch={replace}
          onNext={() => setOpenAt((i) => Math.min(i + 1, queue.length - 1))}
          hasNext={openAt < queue.length - 1}
        />
      ) : (
        <section className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted">{error || 'Nothing selected.'}</p>
        </section>
      )}
    </div>
  )
}

function Bench({ item, version, classes, me, onPatch, onNext, hasNext }) {
  const saved = useMemo(() => item.boxes, [item.boxes])
  const hist = useBoxHistory(saved, `${item.split}/${item.name}`)
  const [cls, setCls] = useState(() => saved[0]?.[0] ?? 0)
  const [selected, setSelected] = useState(-1)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const dirty = !boxesEqual(hist.boxes, saved)
  const status = item.flag?.status
  const fixer = item.flag?.corrected_by

  const setClassOf = useCallback((c) => {
    setCls(c)
    if (selected >= 0 && hist.boxes[selected]) {
      const next = hist.boxes.slice()
      next[selected] = [c, ...next[selected].slice(1)]
      hist.set(next)
    }
  }, [selected, hist])

  const remove = useCallback(() => {
    if (selected < 0) return
    hist.set(hist.boxes.filter((_, i) => i !== selected))
    setSelected(-1)
  }, [selected, hist])

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.matches('textarea, input')) return
      if (e.key === 'Escape') setSelected(-1)
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove() }
      if (e.key >= '1' && e.key <= '9' && !e.metaKey && !e.ctrlKey) {
        const c = Number(e.key) - 1
        if (c < classes.length) setClassOf(c)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? hist.redo() : hist.undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [remove, setClassOf, classes.length, hist])

  const run = async (what, fn) => {
    setBusy(what)
    setError('')
    try {
      return await fn()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy('')
    }
  }

  const save = () => run('save', async () => {
    const d = await saveLabels({
      v: version, split: item.split, image: item.name, boxes: hist.boxes,
    })
    onPatch(item.name, item.split, { boxes: d.boxes, flag: d.flag, labeled: true })
    hist.reset(d.boxes)
    if (hasNext) onNext()
  })

  const revert = () => run('revert', async () => {
    const d = await revertLabels({ v: version, split: item.split, image: item.name })
    onPatch(item.name, item.split, { boxes: d.boxes, flag: d.flag })
    hist.reset(d.boxes)
    setSelected(-1)
  })

  const reject = () => run('reject', async () => {
    const flag = await saveFlag({
      v: version, split: item.split, image: item.name, status: 'no',
    })
    onPatch(item.name, item.split, { flag })
  })

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-5 py-2.5 text-sm">
        <strong className="break-all">{item.name}</strong>
        <span className="text-muted">{splitLabel(item.split)}</span>
        {status === 'review' && (
          <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ background: 'var(--color-review-fill)',
                         color: 'var(--color-review-ink)' }}>
            Review
          </span>
        )}
        <span className="flex-1" />
        {fixer && (
          <span className="text-xs text-muted">
            corrected by {fixer === me ? 'you' : fixer}
            {item.flag?.corrected_ts ? ` · ${when(item.flag.corrected_ts)}` : ''}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 items-center justify-center bg-stage p-3">
          <BoxEditor
            src={imgUrl(version, item.split, item.name)} alt={item.name}
            dim={item.dim} boxes={hist.boxes} classes={classes} cls={cls}
            selected={selected} onSelect={setSelected} onChange={hist.set}
          />
        </div>

        <div className="w-full shrink-0 overflow-y-auto border-t border-line bg-card p-4 lg:w-72 lg:border-l lg:border-t-0">
          <h2 className="text-xs font-medium text-ink2">
            Class for new boxes{selected >= 0 ? ' and the selected one' : ''}
          </h2>
          <ul className="-mx-1.5 mt-1.5 max-h-[34vh] overflow-y-auto">
            {classes.map((name, i) => (
              <li key={i}>
                <button
                  onClick={() => setClassOf(i)}
                  className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm ${
                    i === cls ? 'bg-hover font-semibold' : 'hover:bg-hover'}`}
                >
                  <span className="size-2.5 shrink-0 rounded-[2px]"
                        style={{ background: classColor(i) }} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {i < 9 && <span className="num text-[11px] text-muted">{i + 1}</span>}
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
            <button onClick={hist.undo} disabled={!hist.canUndo}
                    className="rounded-md border border-rule bg-card px-2 py-1 hover:bg-hover disabled:opacity-40">
              Undo
            </button>
            <button onClick={hist.redo} disabled={!hist.canRedo}
                    className="rounded-md border border-rule bg-card px-2 py-1 hover:bg-hover disabled:opacity-40">
              Redo
            </button>
            <button onClick={remove} disabled={selected < 0}
                    className="rounded-md border border-rule bg-card px-2 py-1 hover:bg-hover disabled:opacity-40">
              Delete box
            </button>
            <span className="num text-muted">{nf(hist.boxes.length)} boxes</span>
          </div>

          <div className="mt-4 space-y-2 border-t border-line pt-3">
            <button
              onClick={save} disabled={!dirty || !!busy}
              className="w-full rounded-md bg-ink px-3 py-2 text-sm font-semibold text-page hover:opacity-90 disabled:opacity-40"
            >
              {busy === 'save' ? 'Saving…'
                : dirty ? 'Save — sends it for approval' : 'Saved'}
            </button>
            <p className="text-[11px] text-muted">
              Saving marks the image <b>Review</b>. Someone else has to accept it
              before it goes back into the dataset.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => hist.reset(saved)} disabled={!dirty}
                className="flex-1 rounded-md border border-rule bg-card px-2 py-1.5 text-xs hover:bg-hover disabled:opacity-40"
              >
                Discard changes
              </button>
              <button
                onClick={item.flag?.corrected ? revert : reject} disabled={!!busy}
                className="flex-1 rounded-md border border-rule bg-card px-2 py-1.5 text-xs hover:bg-hover disabled:opacity-40"
              >
                {item.flag?.corrected ? 'Revert to original' : 'Leave rejected'}
              </button>
            </div>
          </div>

          {error && <p className="mt-2 text-[11px] text-no">{error}</p>}

          <p className="mt-4 text-[11px] text-muted">
            Drag empty space to draw · drag inside to move · corners to resize ·
            <b> 1</b>–<b>9</b> class · <b>⌫</b> delete · <b>⌘Z</b> undo
          </p>
        </div>
      </div>
    </section>
  )
}
