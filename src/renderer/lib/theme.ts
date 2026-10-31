import type { ThemePreference } from '@shared/settings'

/**
 * Applies a theme preference to the document.
 *
 * `styles.css` defines the light ramp on bare `:root`, the dark ramp under both
 * `prefers-color-scheme: dark` and `[data-theme="dark"]`, and the light ramp again
 * under `[data-theme="light"]` — so stamping the attribute wins in *both*
 * directions, and removing it falls back to whatever the OS says.
 *
 * That means 'system' is expressed by the absence of the attribute, not by a
 * third value: there is no CSS that could read `data-theme="system"`.
 */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement
  if (preference === 'system') delete root.dataset.theme
  else root.dataset.theme = preference
}

/**
 * Resolves a CSS custom property to its computed value.
 *
 * Canvas `ctx.fillStyle`/`strokeStyle` cannot take `var(--x)` — they need a real
 * colour. Anything drawn as app chrome onto a canvas therefore has to read the
 * token at draw time, or it silently keeps whichever theme's literal was hardcoded.
 * Read at draw time rather than cached, so a theme switch is picked up on the next
 * repaint without an invalidation path.
 */
export function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/**
 * The renderer's one copy of the preference.
 *
 * The rail toggle reads it (`useSyncExternalStore`) and `startThemeSync` keeps it
 * in step with main, so the icon and the painted theme cannot disagree. It used
 * to be two copies, each setting itself from every `settings:changed`, and that
 * raced: a click paints and persists optimistically, and the broadcast of an
 * *older* write (the previous click's, or anyone's from before the click) landed
 * afterwards and painted the old theme back. Two quick clicks could end on the
 * first one's theme, and the next click then cycled from the wrong place.
 */
let current: ThemePreference = 'system'
const subscribers = new Set<() => void>()
/**
 * Local writes main has not answered yet. Main applies writes in order and
 * broadcasts each before replying to it, so while one is in flight every
 * broadcast describes a state the user has already clicked past.
 */
let inFlight = 0
/** Bumped by every local write, so a read that started before one can tell it is stale. */
let writes = 0

function publish(next: ThemePreference): void {
  current = next
  applyTheme(next)
  for (const fn of subscribers) fn()
}

export function getThemePreference(): ThemePreference {
  return current
}

export function subscribeThemePreference(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

/**
 * Paints the preference now, then persists it.
 *
 * Never waits for main before painting (the capture path's "never wait for the
 * product" rule applies to a theme click too), and never rejects. When the last
 * write in flight settles, main's saved value is applied, so a value main
 * sanitized or a write that failed cannot leave the UI claiming a theme that is
 * not on disk.
 */
export async function setThemePreference(next: ThemePreference): Promise<void> {
  inFlight++
  writes++
  publish(next)
  let saved: ThemePreference | null = null
  try {
    const res = await window.api.updateSettings({ theme: next })
    if (res.ok) saved = res.value.theme
  } catch {
    // Treated like a failed write: fall through to re-reading what is on disk.
  } finally {
    inFlight--
  }
  // A newer click is still in flight; its answer is the one that counts.
  if (inFlight > 0) return
  if (saved !== null) {
    publish(saved)
    return
  }
  const before = writes
  const res = await window.api.getSettings().catch(() => null)
  if (res?.ok && inFlight === 0 && writes === before) publish(res.value.theme)
}

/**
 * Reads the persisted preference, applies it, and keeps it applied.
 *
 * Called before React mounts so the first paint is already the right theme —
 * applying it in an effect would flash the OS theme first. Returns an unsubscribe
 * for symmetry; the app-lifetime subscription never actually uses it.
 */
export async function startThemeSync(): Promise<() => void> {
  const stop = window.api.onSettingsChanged((next) => {
    if (inFlight === 0) publish(next.theme)
  })
  const before = writes
  const res = await window.api.getSettings()
  // A failure to read settings must not leave the app unrendered — the OS
  // preference is a correct answer, and it is what the absent attribute gives us.
  // A click that landed while the read was in flight is newer than its answer.
  if (res.ok && writes === before) publish(res.value.theme)
  return stop
}
