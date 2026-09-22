const json = async (url) => {
  const r = await fetch(url)
  if (!r.ok) {
    let msg = await r.text()
    try { msg = JSON.parse(msg).error ?? msg } catch { /* plain text */ }
    throw new Error(msg.slice(0, 300) || r.statusText)
  }
  return r.json()
}

const qs = (params) => new URLSearchParams(params).toString()

export const getVersions = () => json('/api/versions')
export const getVersion = (v) => json('/api/version?' + qs({ v }))
export const getItems = (params) => json('/api/items?' + qs(params))
export const getMeta = () => json('/api/review/meta')
export const getSummary = (v) => json('/api/review/summary?' + qs({ v }))
export const getRejects = (v) => json('/api/review/rejects?' + qs({ v }))
/** Everything waiting for work in one version, across every split. */
export const getQueue = (v, status = 'no,review') =>
  json('/api/queue?' + qs({ v, status }))
export const getTree = (path) => json('/api/tree?' + qs({ path: path || '' }))
export const refresh = () => json('/api/refresh')

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || 'could not save')
  return d
}

/** Every write answers with the image's whole flag — verdict plus the full
 *  comment thread — so a reviewer who missed someone else's comment catches up
 *  on their next click instead of drifting out of date. */
const write = (url, body) => post(url, body).then((d) => d.flag)

export const saveFlag = (body) => write('/api/flag', body)
/** Redrawn boxes. The server flips the image to "review" in the same write, so
 *  the flag that comes back already says so, and the boxes that are now current
 *  come back with it — after a revert those are the dataset's own again. */
export const saveLabels = (body) => post('/api/labels', body)
export const revertLabels = (body) => post('/api/labels/revert', body)
export const addComment = (body) => write('/api/comment', body)
/** Same route with the comment's id: the log gets a second line under that id
 *  and the replay treats it as a rewording of the first. */
export const editComment = (body) => write('/api/comment', body)
export const deleteComment = (body) => write('/api/comment/delete', body)

/** Written in place of a name when the proxy was meant to supply one and did
 *  not. Nobody owns those, so anybody may tidy them up. */
export const UNOWNED = 'unauthenticated'

export const imgUrl = (v, split, name, thumb) =>
  '/img?' + qs(thumb ? { t: 1, v, split, n: name } : { v, split, n: name })

export const folderZipUrl = (path, exclude) =>
  '/download?' + qs(exclude ? { path, exclude: 1 } : { path })

export const fileUrl = (path) => '/file?' + qs({ path })
export const reviewCsvUrl = (v) => '/api/review/export?' + qs({ v })
