/**
 * FR-REC.3 — the recovery offer.
 *
 * Shown on launch when main found a recording directory with a manifest, bytes
 * and no commit marker: the app or the OS died while it was recording. The
 * bytes are already on disk, so this is an offer, not a repair — and it stays
 * on offer until the user acts, because silently adopting or silently deleting
 * someone's recording are both worse than asking.
 *
 * The duration is deliberately labelled as approximate. An interrupted
 * container has no trailing index, so its real duration is not knowable without
 * decoding it; presenting the estimate as exact would be a small lie in the one
 * place the user is deciding whether the file is worth keeping.
 */

import { Button } from './ui'
import type { RecoverableRecordingInfo } from '@shared/types'

function approxDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `about ${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `about ${m}m ${String(s).padStart(2, '0')}s`
}

function sizeLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function RecoveryBanner({
  items,
  onRecover,
  onDiscard
}: {
  items: RecoverableRecordingInfo[]
  onRecover: (id: string) => void
  onDiscard: (id: string) => void
}): React.JSX.Element | null {
  // The empty state of this surface is its absence: a banner reading "nothing to
  // recover" would be noise on every normal launch.
  if (items.length === 0) return null

  return (
    <div className="shrink-0 border-b border-border bg-warning-surface" role="region" aria-label="Interrupted recordings">
      {items.map((item) => (
        <div key={item.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
          {/* UX-A11Y.4 — a glyph, not just the amber surface. */}
          <span className="text-warning" aria-hidden="true">
            ⚠
          </span>
          <p className="min-w-0 flex-1 text-sm text-warning">
            <span className="font-medium">A recording was interrupted.</span>{' '}
            <span>
              {approxDuration(item.estimatedDurationMs)} of {item.container.toUpperCase()} video (
              {sizeLabel(item.size)}) was saved before the app stopped. The end may be truncated.
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="primary" onClick={() => onRecover(item.id)}>
              Recover to library
            </Button>
            <Button
              variant="subtle"
              onClick={() => onDiscard(item.id)}
              title="Deletes the partial recording permanently"
            >
              Discard
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
