import { useCallback, useEffect, useState } from 'react'

const KEY = 'theme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')

/** null means "follow the OS"; the stored value wins over it when set. */
const stored = () => {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : null
}

export function useTheme() {
  const [choice, setChoice] = useState(stored)
  const [system, setSystem] = useState(() => (media().matches ? 'dark' : 'light'))

  useEffect(() => {
    const m = media()
    const onChange = (e) => setSystem(e.matches ? 'dark' : 'light')
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [])

  // The attribute is what the stylesheet keys off; removing it hands control
  // back to the prefers-color-scheme block.
  useEffect(() => {
    const root = document.documentElement
    if (choice) root.setAttribute('data-theme', choice)
    else root.removeAttribute('data-theme')
  }, [choice])

  const theme = choice ?? system
  const toggle = useCallback(() => {
    setChoice((c) => {
      const next = (c ?? (media().matches ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark'
      localStorage.setItem(KEY, next)
      return next
    })
  }, [])
  const useSystem = useCallback(() => {
    localStorage.removeItem(KEY)
    setChoice(null)
  }, [])

  return { theme, following: choice === null, toggle, useSystem }
}
