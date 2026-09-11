import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fileUrl, folderZipUrl, getRejects, getTree } from '../lib/api'
import { bytes, nf } from '../lib/format'
import { useData } from '../lib/store'

const FolderIcon = () => (
  <svg viewBox="0 0 20 20" className="size-4.5 shrink-0 fill-brand" aria-hidden="true">
    <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h3.4a1.5 1.5 0 0 1 1.06.44L9.2 5.5h7.3A1.5 1.5 0 0 1 18 7v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 15.5z" />
  </svg>
)

const FileIcon = () => (
  <svg viewBox="0 0 20 20" className="size-4.5 shrink-0 fill-none stroke-muted"
       strokeWidth="1.6" aria-hidden="true">
    <path d="M5 2.8h6.2L15.2 7v10.2H5z" />
    <path d="M11 2.8V7h4.2" />
  </svg>
)

export default function Files() {
  const [params, setParams] = useSearchParams()
  const path = params.get('path') || ''
  const { root } = useData()
  const [data, setData] = useState(null)
  const [rejects, setRejects] = useState(null)
  const [error, setError] = useState(null)

  const version = path.split('/')[0] || ''
  const atVersionRoot = version && path.split('/').length === 1

  useEffect(() => {
    let stale = false
    setError(null)
    getTree(path)
      .then((d) => !stale && setData(d))
      .catch((e) => !stale && setError(e.message))
    return () => { stale = true }
  }, [path])

  // Only a version knows which images were rejected, so the filtered download
  // is offered exactly where it means something.
  useEffect(() => {
    if (!atVersionRoot) { setRejects(null); return }
    let stale = false
    getRejects(version).then((r) => !stale && setRejects(r)).catch(() => {})
    return () => { stale = true }
  }, [version, atVersionRoot])

  const go = (p) => setParams(p ? { path: p } : {})

  if (error) return <p className="p-8 text-sm text-no">{error}</p>
  if (!data) return <p className="p-8 text-sm text-muted">Loading…</p>

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <nav className="flex flex-wrap items-center gap-1 text-sm">
              <button onClick={() => go('')}
                      className={`rounded px-1.5 py-0.5 hover:bg-hover ${
                        path ? 'text-brand' : 'font-semibold'}`}>
                dataset root
              </button>
              {data.crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center gap-1">
                  <span className="text-muted">/</span>
                  <button onClick={() => go(c.path)}
                          className={`rounded px-1.5 py-0.5 hover:bg-hover ${
                            i === data.crumbs.length - 1 ? 'font-semibold' : 'text-brand'}`}>
                    {c.name}
                  </button>
                </span>
              ))}
            </nav>
            <p className="mt-1 px-1.5 text-xs text-muted">
              {root}{path ? '/' + path : ''}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <a href={folderZipUrl(path)} download
               className="rounded-md bg-ink px-3 py-2 text-sm font-semibold text-page hover:opacity-90">
              Download {path ? 'this folder' : 'everything'} (.zip)
            </a>
            {atVersionRoot && (
              <a
                href={folderZipUrl(path, true)} download
                title="Same version with every rejected image and its label left out"
                className="rounded-md border border-rule bg-card px-3 py-2 text-sm hover:bg-hover"
              >
                Download reviewed
                {rejects?.total ? ` — ${nf(rejects.total)} excluded` : ''}
              </a>
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-line bg-card">
          <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs text-muted">
            <span>{nf(data.dirs)} folder{data.dirs === 1 ? '' : 's'}</span>
            <span>·</span>
            <span>{nf(data.files)} file{data.files === 1 ? '' : 's'}</span>
            {data.bytes > 0 && <><span>·</span><span>{bytes(data.bytes)} here</span></>}
          </div>

          {data.entries.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted">This folder is empty.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.entries.map((e) => {
                const full = path ? `${path}/${e.name}` : e.name
                return (
                  <li key={e.name} className="flex items-center gap-3 px-4 py-2 hover:bg-hover">
                    {e.type === 'dir' ? <FolderIcon /> : <FileIcon />}
                    {e.type === 'dir' ? (
                      <button onClick={() => go(full)}
                              className="min-w-0 flex-1 truncate text-left text-sm hover:underline">
                        {e.name}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
                    )}
                    <span className="num shrink-0 text-xs text-muted">
                      {e.type === 'dir'
                        ? `${nf(e.items)} item${e.items === 1 ? '' : 's'}`
                        : bytes(e.size)}
                    </span>
                    <a
                      href={e.type === 'dir' ? folderZipUrl(full) : fileUrl(full)}
                      download
                      className="shrink-0 rounded border border-line px-2 py-1 text-xs text-ink2 hover:bg-hover"
                    >
                      {e.type === 'dir' ? 'zip' : 'get'}
                    </a>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <p className="mt-4 text-xs text-muted">
          Downloads stream straight from disk, so a large version starts immediately
          instead of being staged first. The dataset is mounted read-only — nothing
          here can change it.
        </p>
      </div>
    </div>
  )
}
