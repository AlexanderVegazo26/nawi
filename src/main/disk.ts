import { app } from 'electron'
import { promises as fs } from 'node:fs'
import type { DiskPressure } from '@shared/types'

/**
 * UX-STA.5 — disk-pressure precheck before a recording starts.
 *
 * The requirement asks for the *estimated size of the intended recording*, not
 * a bare "low disk space". A number the user can compare to the space they have
 * is what turns the warning into a decision; "running low" is a shrug.
 */

/** PRD-002 UX-STA.5 threshold. */
export const LOW_SPACE_BYTES = 2 * 1024 * 1024 * 1024

/**
 * The encoder's video bitrate, mirrored from `ScreenRecorder` in the renderer.
 *
 * Duplicated deliberately rather than imported: `src/renderer/**` is a separate
 * TS project that main does not compile against. The constant is exported so a
 * test can assert the two agree, which is the part that would otherwise drift.
 */
export const VIDEO_BITS_PER_SECOND = 8_000_000

/** Bytes a recording of `minutes` minutes is expected to occupy. */
export function estimateRecordingBytes(minutes: number): number {
  return Math.round((VIDEO_BITS_PER_SECOND / 8) * 60 * minutes)
}

/**
 * Free space on the volume that holds the library.
 *
 * `fs.statfs` is used rather than shelling out to `wmic`/`df`: it is in Node
 * since 18.15 and Electron 44 is well past that, so no dependency and no child
 * process is needed. A failure to stat resolves to "we do not know" rather than
 * to "plenty of room" — an unknown must never suppress the warning by looking
 * like a pass.
 */
export async function diskPressure(estimateMinutes = 5): Promise<DiskPressure> {
  const estimatedBytes = estimateRecordingBytes(estimateMinutes)
  try {
    const stats = await fs.statfs(app.getPath('userData'))
    const freeBytes = Number(stats.bavail) * Number(stats.bsize)
    return {
      known: true,
      freeBytes,
      estimatedBytes,
      estimateMinutes,
      low: freeBytes < LOW_SPACE_BYTES
    }
  } catch {
    return { known: false, freeBytes: 0, estimatedBytes, estimateMinutes, low: false }
  }
}
