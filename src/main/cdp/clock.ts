/**
 * DC-1 / FR-STA.7 — one monotonic clock for the pixel layer and the state
 * layer, holding under 100 ms of drift across a 30-minute recording.
 *
 * **There are three clocks here, not two.** Conflating any two of them
 * produces a plausible-looking timestamp that is silently wrong, which is
 * worse than no timestamp at all:
 *
 *  - **T** — the capture timeline. `process.hrtime.bigint()` at capture start
 *    is the origin; every `t_ms` in the sidecar is milliseconds since it. This
 *    is the clock the pixel layer already uses, so it is the destination of
 *    every conversion below.
 *  - **Browser epoch** — `performance.timeOrigin + performance.now()`, and
 *    `Network.requestWillBeSent.wallTime` (seconds). Wall-clock milliseconds
 *    on the *browser's* machine-clock, which is not our hrtime and not ours to
 *    assume in step with it.
 *  - **CDP `MonotonicTime`** — the `timestamp` field on essentially every CDP
 *    event. **Seconds** since an arbitrary Chrome-internal origin. It is
 *    neither epoch nor the `performance` origin; treating it as either is a
 *    multi-hour error.
 *
 * `Network.requestWillBeSent` is the one event carrying a `MonotonicTime`
 * `timestamp` and an epoch `wallTime` together — a free bridge between the
 * second and third clocks, needing no extra round trip.
 *
 * A single Cristian offset does not hold: 100 ppm of relative clock rate is
 * ordinary, and over 1800 s that is 180 ms — already over budget. So offsets
 * are re-sampled and fitted with least squares, which recovers the *rate* as
 * well as the offset.
 *
 * Every converter returns `number | null`, and **null means the event must be
 * dropped.** DC-1 is explicit: a state event that cannot be timestamped is
 * dropped, never guessed and never zeroed.
 */

/** One Cristian round trip: browser time observed between two local readings. */
export interface ClockSample {
  /** T at which the request was sent. */
  sentTMs: number
  /** T at which the reply was received. */
  receivedTMs: number
  /** Browser epoch ms reported inside that window. */
  browserEpochMs: number
}

interface FitSample {
  /** Independent variable: T (ms). */
  x: number
  /** Dependent variable: the other clock's reading (ms). */
  y: number
  /** Uncertainty. Smaller is better; ties are broken toward the newer sample. */
  rttMs: number
  seq: number
}

/** `y = intercept + slope * x`. */
export interface LinearFit {
  intercept: number
  slope: number
  sampleCount: number
  /** Fitted rate error in parts per million, i.e. how fast the other clock runs. */
  driftPpm: number
  /** Span of T covered by the samples, in ms. A short span cannot constrain slope. */
  spanMs: number
}

export interface CaptureClockOptions {
  /** hrtime origin. Defaults to now. Pass the value taken at hotkey press. */
  originHr?: bigint
  /** Host epoch ms at the origin, for `wallToTMs`. Defaults to now. */
  originEpochMs?: number
  /** Cap on retained samples per domain. Worst-RTT interior samples are dropped first. */
  maxSamples?: number
  /**
   * Below this span the slope is not identifiable and a rate of exactly 1 is
   * used instead of a fitted one — fitting a rate from two samples 50 ms apart
   * amplifies RTT noise into an absurd drift.
   */
  minSpanForSlopeMs?: number
}

const DEFAULTS = {
  maxSamples: 64,
  minSpanForSlopeMs: 60_000
} as const

/**
 * Weighted-ish least squares of y on x. Unweighted by design: samples are
 * already filtered to the best-RTT ones, and weighting by 1/rtt² on a handful
 * of near-equal RTTs buys precision that the RTT estimate itself does not have.
 *
 * x is centred before solving so the normal equations stay conditioned when x
 * is large (T runs to ~1.8e6 ms over a 30-minute recording, y to ~1.8e12 ms).
 */
function fitLine(samples: FitSample[], minSpanForSlopeMs: number): LinearFit | null {
  if (samples.length === 0) return null

  const n = samples.length
  const meanX = samples.reduce((sum, s) => sum + s.x, 0) / n
  const meanY = samples.reduce((sum, s) => sum + s.y, 0) / n
  const spanMs = Math.max(...samples.map((s) => s.x)) - Math.min(...samples.map((s) => s.x))

  let sxx = 0
  let sxy = 0
  for (const s of samples) {
    const dx = s.x - meanX
    sxx += dx * dx
    sxy += dx * (s.y - meanY)
  }

  const canFitSlope = n >= 2 && spanMs >= minSpanForSlopeMs && sxx > 0
  const slope = canFitSlope ? sxy / sxx : 1
  const intercept = meanY - slope * meanX
  return { intercept, slope, sampleCount: n, driftPpm: (slope - 1) * 1e6, spanMs }
}

/** Keep the best-RTT samples without collapsing the time span the slope depends on. */
function prune(samples: FitSample[], maxSamples: number): void {
  while (samples.length > maxSamples) {
    let worstIndex = -1
    let worstRtt = -Infinity
    // Never evict the first or last sample: they define the span, and a fit
    // over a shrinking window is exactly how drift correction quietly dies.
    for (let i = 1; i < samples.length - 1; i++) {
      const s = samples[i]!
      if (s.rttMs > worstRtt) {
        worstRtt = s.rttMs
        worstIndex = i
      }
    }
    if (worstIndex < 0) return
    samples.splice(worstIndex, 1)
  }
}

export class CaptureClock {
  readonly originHr: bigint
  readonly originEpochMs: number

  private readonly maxSamples: number
  private readonly minSpanForSlopeMs: number
  private seq = 0

  /** T → browser epoch ms. */
  private readonly browserSamples: FitSample[] = []
  /** CDP MonotonicTime (ms) → browser epoch ms. */
  private readonly monotonicSamples: FitSample[] = []
  /** T → host epoch ms. */
  private readonly hostSamples: FitSample[] = []

  private browserFit: LinearFit | null = null
  private monotonicFit: LinearFit | null = null
  private hostFit: LinearFit | null = null

  constructor(options: CaptureClockOptions = {}) {
    this.originHr = options.originHr ?? process.hrtime.bigint()
    this.originEpochMs = options.originEpochMs ?? Date.now()
    this.maxSamples = options.maxSamples ?? DEFAULTS.maxSamples
    this.minSpanForSlopeMs = options.minSpanForSlopeMs ?? DEFAULTS.minSpanForSlopeMs
    // The origin itself is a host-clock sample, so `wallToTMs` works from t=0.
    this.hostSamples.push({ x: 0, y: this.originEpochMs, rttMs: 0, seq: this.seq++ })
    this.hostFit = fitLine(this.hostSamples, this.minSpanForSlopeMs)
  }

  /** Current T, in ms since the capture origin. */
  nowTMs(): number {
    return Number(process.hrtime.bigint() - this.originHr) / 1e6
  }

  /** Convert any hrtime reading to T. */
  hrToTMs(hr: bigint): number {
    return Number(hr - this.originHr) / 1e6
  }

  /**
   * Record one Cristian round trip. The browser's reading is assumed to have
   * been taken at the midpoint of the local send/receive window; the residual
   * error is bounded by RTT/2, which is why the best-RTT samples are the ones
   * kept.
   */
  addBrowserSample(sample: ClockSample): void {
    const rttMs = sample.receivedTMs - sample.sentTMs
    if (!Number.isFinite(rttMs) || rttMs < 0 || !Number.isFinite(sample.browserEpochMs)) return
    const midpoint = (sample.sentTMs + sample.receivedTMs) / 2
    this.browserSamples.push({ x: midpoint, y: sample.browserEpochMs, rttMs, seq: this.seq++ })
    prune(this.browserSamples, this.maxSamples)
    this.browserFit = fitLine(this.browserSamples, this.minSpanForSlopeMs)
  }

  /**
   * The free bridge: `Network.requestWillBeSent` reports both clocks in one
   * event, so this needs no round trip and carries no RTT uncertainty.
   *
   * Both arguments are **seconds**, as CDP sends them.
   */
  addMonotonicBridge(monotonicSeconds: number, wallTimeSeconds: number): void {
    if (!Number.isFinite(monotonicSeconds) || !Number.isFinite(wallTimeSeconds)) return
    if (wallTimeSeconds <= 0) return
    this.monotonicSamples.push({
      x: monotonicSeconds * 1000,
      y: wallTimeSeconds * 1000,
      rttMs: 0,
      seq: this.seq++
    })
    prune(this.monotonicSamples, this.maxSamples)
    this.monotonicFit = fitLine(this.monotonicSamples, this.minSpanForSlopeMs)
  }

  /** Re-anchor the host wall clock against T. Cheap; call it beside each browser sample. */
  sampleHostClock(): void {
    this.hostSamples.push({ x: this.nowTMs(), y: Date.now(), rttMs: 0, seq: this.seq++ })
    prune(this.hostSamples, this.maxSamples)
    this.hostFit = fitLine(this.hostSamples, this.minSpanForSlopeMs)
  }

  /**
   * Browser epoch ms → T. `null` when the browser clock has never been
   * calibrated, which per DC-1 means the caller must **drop** the event.
   */
  browserToTMs(browserEpochMs: number): number | null {
    if (!Number.isFinite(browserEpochMs)) return null
    const fit = this.browserFit
    if (!fit || fit.slope === 0) return null
    return (browserEpochMs - fit.intercept) / fit.slope
  }

  /**
   * CDP `MonotonicTime` (**seconds**) → T. Goes through the monotonic→epoch
   * bridge and then the browser→T fit; `null` if either leg is uncalibrated.
   */
  monotonicToTMs(monotonicSeconds: number): number | null {
    if (!Number.isFinite(monotonicSeconds)) return null
    const fit = this.monotonicFit
    if (!fit) return null
    const epochMs = fit.intercept + fit.slope * (monotonicSeconds * 1000)
    return this.browserToTMs(epochMs)
  }

  /**
   * Host wall-clock epoch ms → T, for events timestamped in *this* process.
   * Never mix this with a browser-reported epoch: use `browserToTMs` for those,
   * or a clock step on either machine lands directly in the timeline.
   */
  wallToTMs(epochMs: number): number | null {
    if (!Number.isFinite(epochMs)) return null
    const fit = this.hostFit
    if (!fit || fit.slope === 0) return null
    return (epochMs - fit.intercept) / fit.slope
  }

  /** Diagnostics, for the sidecar's capture metadata and for tests. */
  stats(): { browser: LinearFit | null; monotonic: LinearFit | null; host: LinearFit | null } {
    return { browser: this.browserFit, monotonic: this.monotonicFit, host: this.hostFit }
  }

  /** True once a browser-domain timestamp can be produced at all. */
  get isBrowserCalibrated(): boolean {
    return this.browserFit !== null
  }
}

/** Minimal surface `calibrateBrowserClock` needs, so the clock never imports the client. */
export interface EvaluatingClient {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>
}

/**
 * One Cristian round trip against a live page, folded into `clock`.
 *
 * Returns the RTT so a caller running several samples can keep the tightest,
 * or `null` if the page returned something unusable — a page can be mid
 * navigation, and a bad reading must not poison the fit.
 */
export async function calibrateBrowserClock(
  clock: CaptureClock,
  client: EvaluatingClient,
  sessionId?: string
): Promise<number | null> {
  const sentTMs = clock.nowTMs()
  const response = await client.send<{ result?: { value?: unknown } }>(
    'Runtime.evaluate',
    { expression: 'performance.timeOrigin + performance.now()', returnByValue: true },
    sessionId
  )
  const receivedTMs = clock.nowTMs()
  const value = response.result?.value
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  clock.addBrowserSample({ sentTMs, receivedTMs, browserEpochMs: value })
  clock.sampleHostClock()
  return receivedTMs - sentTMs
}
