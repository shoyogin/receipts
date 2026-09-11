import { useTheme } from '../lib/theme'

const Sun = () => (
  <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <circle cx="10" cy="10" r="3.6" />
    <path d="M10 2.4v1.8M10 15.8v1.8M17.6 10h-1.8M4.2 10H2.4M15.4 4.6l-1.3 1.3M5.9 14.1l-1.3 1.3M15.4 15.4l-1.3-1.3M5.9 5.9 4.6 4.6" />
  </svg>
)

const Moon = () => (
  <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
    <path d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9" />
  </svg>
)

/** One button: click flips the theme and remembers it. Double-click hands
 *  control back to the operating system, which is where it starts. */
export default function ThemeToggle() {
  const { theme, following, toggle, useSystem } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      onClick={toggle}
      onDoubleClick={useSystem}
      aria-label={`Switch to ${next} theme`}
      title={following
        ? `Following your system (${theme}) — click for ${next}`
        : `${theme} theme — click for ${next}, double-click to follow your system`}
      className="relative rounded-md border border-rule bg-card p-2 text-ink2 hover:bg-hover"
    >
      {theme === 'dark' ? <Moon /> : <Sun />}
      {following && (
        <span className="absolute right-1 top-1 size-1.5 rounded-full bg-brand"
              aria-hidden="true" />
      )}
    </button>
  )
}
