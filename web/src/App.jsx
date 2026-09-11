import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import ThemeToggle from './components/ThemeToggle'
import { DataProvider, useData } from './lib/store'
import Files from './pages/Files'
import Review from './pages/Review'
import Stats from './pages/Stats'

const tabs = [
  { to: '/', label: 'Files', end: true },
  { to: '/review', label: 'Review' },
  { to: '/stats', label: 'Stats' },
]

function VersionPicker() {
  const { versions, version, setVersion } = useData()
  if (versions.length === 0) return null
  return (
    <label className="flex items-center gap-2 text-sm text-ink2">
      Version
      <select
        value={version}
        onChange={(e) => setVersion(e.target.value)}
        className="rounded-md border border-rule bg-card px-2 py-1.5 text-sm text-ink"
      >
        {versions.map((v) => <option key={v}>{v}</option>)}
      </select>
    </label>
  )
}

function Shell() {
  const { pathname } = useLocation()
  const { error, loading, rescan } = useData()

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-surface px-5 py-3">
        <span className="font-semibold tracking-tight">Dataset browser</span>
        <nav className="flex gap-1">
          {tabs.map((t) => (
            <NavLink
              key={t.to} to={t.to} end={t.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm ${
                  isActive ? 'bg-ink font-semibold text-page' : 'text-ink2 hover:bg-hover'
                }`}
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {pathname !== '/' && <VersionPicker />}
          <button
            onClick={rescan}
            className="rounded-md border border-rule bg-card px-3 py-1.5 text-sm hover:bg-hover"
          >
            Rescan disk
          </button>
          <ThemeToggle />
        </div>
      </header>

      {error && (
        <p className="border-b border-line bg-no/10 px-5 py-2 text-sm text-no">{error}</p>
      )}

      <main className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <p className="p-8 text-sm text-muted">Loading…</p>
        ) : (
          <Routes>
            <Route path="/" element={<Files />} />
            <Route path="/review" element={<Review />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="*" element={<Files />} />
          </Routes>
        )}
      </main>
    </div>
  )
}

export default function App() {
  return (
    <DataProvider>
      <Shell />
    </DataProvider>
  )
}
