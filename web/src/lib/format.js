export const nf = (n) => Number(n || 0).toLocaleString('en-US')

export const pct = (part, whole, digits = 1) =>
  whole ? ((part / whole) * 100).toFixed(digits) + '%' : '0%'

export function bytes(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  const v = n / 1024 ** i
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`
}

export const when = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) : '')

export const splitLabel = (s) => (s === '.' ? 'root' : s)
