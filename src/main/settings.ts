import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { defaultSettings, mergeSettings, sanitizeSettings, type Settings } from '@shared/settings'

/**
 * Settings store — one JSON file under userData.
 *
 * Persistence deliberately mirrors `library.ts`: an in-memory cache, writes to a
 * tmp file followed by `fs.rename`, and every write chained on a *settled* tail so
 * one rejection cannot poison the queue. Same reasoning, same failure modes, one
 * pattern to reason about.
 *
 * The path is resolved lazily on every call rather than at module scope, so this
 * module is importable before `app` is ready (and mockable in unit tests).
 */

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

let cache: Settings | null = null
let writeChain: Promise<unknown> = Promise.resolve()

/** Notified after a write lands on disk. Used to broadcast `settings:changed`. */
type Listener = (next: Settings) => void
const listeners = new Set<Listener>()

export function onSettingsChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8')
    // Unknown/absent/malformed fields fall back to defaults field-by-field, so a
    // hand-edited file loses only what it actually broke.
    cache = sanitizeSettings(JSON.parse(raw) as unknown)
  } catch {
    // Missing file is the normal first-run case; a corrupt one is recovered the
    // same way. The bad file is left untouched rather than silently overwritten —
    // it is the only copy of whatever the user meant to write.
    cache = defaultSettings()
  }
  return cache
}

/**
 * Runs read → merge → write as one unit on the shared chain.
 *
 * Merging outside the chain would read a base that a queued write is about to
 * replace, so two settings toggles fired back-to-back would silently discard the
 * first — a lost update, with the UI reporting both as saved.
 */
function enqueue(apply: (current: Settings) => Settings): Promise<Settings> {
  const task = writeChain.catch(() => undefined).then(async () => {
    const next = apply(await getSettings())
    const target = settingsPath()
    await fs.mkdir(join(target, '..'), { recursive: true })
    const tmp = `${target}.tmp`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8')
    await fs.rename(tmp, target)
    // Publish only once the bytes are on disk, so the UI can never report state
    // that did not persist.
    cache = next
    return next
  })

  writeChain = task
  return task.catch((err: unknown) => {
    // Re-hydrate from whatever is truly on disk next time.
    cache = null
    throw err
  })
}

/**
 * Applies an untrusted partial patch and persists the result.
 *
 * Validation happens here, in main, against the current on-disk state — the
 * renderer's payload is never written through unexamined.
 */
export async function updateSettings(patch: unknown): Promise<Settings> {
  const saved = await enqueue((current) => mergeSettings(current, patch))
  for (const fn of listeners) {
    try {
      fn(saved)
    } catch (err) {
      // A broken listener must not fail the write that already succeeded.
      console.error('[settings] listener failed', err)
    }
  }
  return saved
}
