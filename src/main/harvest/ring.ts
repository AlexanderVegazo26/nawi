/**
 * A bounded, time-windowed buffer for FR-STA.3's "recording window plus 30 s of
 * preamble".
 *
 * Two independent bounds, because either one alone fails:
 *
 *  - **Time**, so the preamble is genuinely 30 s and not "whatever 5000 entries
 *    happened to span" — a chatty page burns that in a second.
 *  - **Count**, so a page in a `console.log` loop cannot exhaust memory before
 *    the time window closes.
 *
 * Entries are held with their *raw* source timestamp and resolved to `t_ms`
 * later. That ordering is deliberate: `browserToTMs` returns null until the
 * clock has been calibrated, so resolving at receipt would silently discard
 * every early entry — exactly the preamble this buffer exists to keep. Eviction
 * therefore runs on a separate, always-available monotonic reading.
 */

export interface RingEntry<T> {
  /** Capture-timeline ms at which this entry was *received*, for eviction only. */
  receivedTMs: number
  value: T
}

export interface RingOptions {
  /** Retention window in ms. Entries older than this relative to the newest are dropped. */
  windowMs: number
  /** Hard cap on retained entries, regardless of the window. */
  maxEntries: number
}

export class RingBuffer<T> {
  private entries: Array<RingEntry<T>> = []
  private droppedCount = 0
  /** Once false, the window stops evicting: everything from here is in-recording. */
  private windowed = true

  constructor(private readonly options: RingOptions) {}

  /**
   * Stop discarding by age.
   *
   * Called when the recording actually starts. Before it, the buffer is a
   * rolling 30 s preamble; after it, FR-STA.3 wants everything, and continuing
   * to evict would quietly truncate the recording's own console output.
   */
  closeWindow(): void {
    this.windowed = false
  }

  push(receivedTMs: number, value: T): void {
    this.entries.push({ receivedTMs, value })
    this.evict()
  }

  private evict(): void {
    if (this.windowed && this.entries.length > 0) {
      const newest = this.entries[this.entries.length - 1]!.receivedTMs
      const cutoff = newest - this.options.windowMs
      let removed = 0
      while (removed < this.entries.length && this.entries[removed]!.receivedTMs < cutoff) removed++
      if (removed > 0) {
        this.entries.splice(0, removed)
        this.droppedCount += removed
      }
    }
    if (this.entries.length > this.options.maxEntries) {
      const excess = this.entries.length - this.options.maxEntries
      this.entries.splice(0, excess)
      this.droppedCount += excess
    }
  }

  /** Retained values, oldest first. */
  values(): T[] {
    return this.entries.map((e) => e.value)
  }

  get size(): number {
    return this.entries.length
  }

  /** How many entries the bounds discarded. Reported, never silently zero. */
  get dropped(): number {
    return this.droppedCount
  }
}
