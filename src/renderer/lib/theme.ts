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
 * Reads the persisted preference, applies it, and keeps it applied.
 *
 * Called before React mounts so the first paint is already the right theme —
 * applying it in an effect would flash the OS theme first. Returns an unsubscribe
 * for symmetry; the app-lifetime subscription never actually uses it.
 */
export async function startThemeSync(): Promise<() => void> {
  const stop = window.api.onSettingsChanged((next) => applyTheme(next.theme))
  const res = await window.api.getSettings()
  // A failure to read settings must not leave the app unrendered — the OS
  // preference is a correct answer, and it is what the absent attribute gives us.
  if (res.ok) applyTheme(res.value.theme)
  return stop
}
