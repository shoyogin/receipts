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
export const getTree = (path) => json('/api/tree?' + qs({ path: path || '' }))
export const refresh = () => json('/api/refresh')

export async function saveFlag(body) {
  const r = await fetch('/api/flag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || 'could not save')
  return d.flag
}

export const imgUrl = (v, split, name, thumb) =>
  '/img?' + qs(thumb ? { t: 1, v, split, n: name } : { v, split, n: name })

export const folderZipUrl = (path, exclude) =>
  '/download?' + qs(exclude ? { path, exclude: 1 } : { path })

export const fileUrl = (path) => '/file?' + qs({ path })
export const reviewCsvUrl = (v) => '/api/review/export?' + qs({ v })
