import { useState } from 'react'
import { folderZipUrl, getSummary } from '../lib/api'
import { nf } from '../lib/format'

/**
 * The reviewed download, with a question in front of it.
 *
 * An export is a decision about every image in the version, including the ones
 * nobody opened. Those ship — silently, which is the problem. So the count is
 * fetched at click time (not from whatever the page loaded with) and, if any
 * image is still unjudged, said out loud before the zip starts.
 */
export default function ConfirmDownload({ version, className, children }) {
  const [ask, setAsk] = useState(null)
  const [busy, setBusy] = useState(false)

  const start = () => { window.location.href = folderZipUrl(version, true) }

  const click = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const s = await getSummary(version)
      if (s.unflagged > 0) return setAsk(s)
      start()
    } catch {
      // A summary we could not read is no reason to withhold the download;
      // the export itself is what matters and it does not depend on this.
      start()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <a href={folderZipUrl(version, true)} onClick={click} className={className}>
        {children}
      </a>

      {ask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
             onClick={() => setAsk(null)}>
          <div onClick={(e) => e.stopPropagation()}
               className="w-full max-w-md rounded-xl border border-line bg-card p-5">
            <h2 className="text-sm font-semibold">
              {nf(ask.unflagged)} of {nf(ask.total)} images are not flagged
            </h2>
            <p className="mt-2 text-sm text-ink2">
              Some of the images have not been marked OK, Not OK or Review. They
              will be included in the download exactly as they are on disk.
              Download the dataset anyway?
            </p>
            <dl className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
              {[['OK', ask.ok, 'text-ok'], ['Not OK', ask.no, 'text-no'],
                ['Review', ask.review, 'text-review'],
                ['Unflagged', ask.unflagged, 'text-muted']].map(([l, n, tone]) => (
                <div key={l} className="rounded-md border border-line py-1.5">
                  <dt className="text-muted">{l}</dt>
                  <dd className={`num font-semibold ${tone}`}>{nf(n || 0)}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setAsk(null)}
                      className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-hover">
                Cancel
              </button>
              <button onClick={() => { setAsk(null); start() }}
                      className="rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-page hover:opacity-90">
                Download anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {busy && <span className="sr-only">checking review state…</span>}
    </>
  )
}
