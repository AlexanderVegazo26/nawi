import { useEffect, useState } from 'react'
import type { ThemePreference } from '@shared/settings'
import { applyTheme } from '../lib/theme'

const ORDER: ThemePreference[] = ['system', 'light', 'dark']

const LABEL: Record<ThemePreference, string> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark'
}

const ICON: Record<ThemePreference, React.JSX.Element> = {
  // Half-filled circle — neither sun nor moon, because "system" is whichever the OS says.
  system: <path d="M12 3a9 9 0 1 0 0 18Zm0 0a9 9 0 0 1 0 18" />,
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  dark: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
}

/**
 * Cycles system → light → dark.
 *
 * The label is the *current* state rather than the next one: a control that names
 * what it will do reads as a description of what is, and users mis-report the
 * theme they are in. `title` carries the action instead.
 */
export function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemePreference>('system')

  useEffect(() => {
    let alive = true
    void window.api.getSettings().then((res) => {
      if (alive && res.ok) setTheme(res.value.theme)
    })
    const stop = window.api.onSettingsChanged((next) => setTheme(next.theme))
    return () => {
      alive = false
      stop()
    }
  }, [])

  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]

  const cycle = (): void => {
    // Paint immediately, then persist. The capture path's "never wait for the
    // product" rule applies to a theme click too, and main broadcasts the
    // authoritative value back either way.
    applyTheme(next)
    setTheme(next)
    void window.api.updateSettings({ theme: next })
  }

  return (
    <button
      onClick={cycle}
      title={`Theme: ${LABEL[theme]} — switch to ${LABEL[next]}`}
      className="flex h-11 w-11 flex-col items-center justify-center rounded-xl text-text-secondary transition-colors motion-tool hover:bg-surface-2 hover:text-text-primary"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {ICON[theme]}
      </svg>
      {/* The visible glyph is ambiguous on its own, so the state is also text for AT. */}
      <span className="sr-only">Theme: {LABEL[theme]}. Switch to {LABEL[next]}.</span>
    </button>
  )
}
