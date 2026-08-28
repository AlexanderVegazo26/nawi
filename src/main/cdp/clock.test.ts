import { describe, expect, it } from 'vitest'
import { CaptureClock } from './clock'

/**
 * A simulated browser clock: offset by `skewMs` at t=0 and running `driftPpm`
 * parts-per-million fast thereafter. 200 ppm over a 30-minute recording is
 * 360 ms of accumulated error — comfortably over FR-STA.7's 100 ms budget, so
 * the test proves the drift *fit* rather than the offset alone.
 */
function browserEpochAt(trueTMs: number, skewMs: number, driftPpm: number, epoch0 = 1_700_000_000_000): number {
  return epoch0 + skewMs + trueTMs * (1 + driftPpm / 1e6)
}

/** Deterministic pseudo-random RTT jitter; a flaky clock test is worse than none. */
function makeJitter(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const THIRTY_MINUTES_MS = 30 * 60 * 1000
const SAMPLE_INTERVAL_MS = 30_000
const SKEW_MS = 4_213
const DRIFT_PPM = 200

interface Trace {
  clock: CaptureClock
  /** Every (trueT, browserEpoch) pair, for checking the conversion afterwards. */
  checkpoints: Array<{ trueTMs: number; browserEpochMs: number }>
  /** The offset a naive single-sample implementation would have frozen at t=0. */
  singleOffsetMs: number
}

function runSimulatedCapture(driftPpm: number): Trace {
  const clock = new CaptureClock({ originHr: 0n, originEpochMs: 0 })
  const jitter = makeJitter(42)
  const checkpoints: Trace['checkpoints'] = []
  let singleOffsetMs = 0

  for (let t = 0; t <= THIRTY_MINUTES_MS; t += SAMPLE_INTERVAL_MS) {
    // Asymmetric, jittery round trip: 4-24 ms out, 4-24 ms back.
    const outboundMs = 4 + jitter() * 20
    const inboundMs = 4 + jitter() * 20
    const sentTMs = t
    const observedAtTMs = t + outboundMs
    const receivedTMs = observedAtTMs + inboundMs
    const browserEpochMs = browserEpochAt(observedAtTMs, SKEW_MS, driftPpm)

    clock.addBrowserSample({ sentTMs, receivedTMs, browserEpochMs })
    if (t === 0) singleOffsetMs = browserEpochMs - (sentTMs + receivedTMs) / 2

    checkpoints.push({ trueTMs: observedAtTMs, browserEpochMs })
  }

  return { clock, checkpoints, singleOffsetMs }
}

describe('FR-STA.7 — drift over a 30-minute recording', () => {
  const trace = runSimulatedCapture(DRIFT_PPM)

  it('keeps corrected error under 100 ms across the whole recording', () => {
    let worst = 0
    for (const { trueTMs, browserEpochMs } of trace.checkpoints) {
      const converted = trace.clock.browserToTMs(browserEpochMs)
      expect(converted).not.toBeNull()
      worst = Math.max(worst, Math.abs((converted as number) - trueTMs))
    }
    expect(worst).toBeLessThan(100)
  })

  it('proves the fit is doing the work — a single fixed offset blows the budget', () => {
    let worst = 0
    for (const { trueTMs, browserEpochMs } of trace.checkpoints) {
      const naive = browserEpochMs - trace.singleOffsetMs
      worst = Math.max(worst, Math.abs(naive - trueTMs))
    }
    expect(worst).toBeGreaterThan(100)
  })

  it('recovers the simulated drift rate', () => {
    const fit = trace.clock.stats().browser
    expect(fit).not.toBeNull()
    // Tolerance stated in the units that matter: RTT jitter of 4-24 ms leaves a
    // few ppm of residual in the slope estimate, and 5 ppm over the full
    // 1800 s recording is 9 ms — a eleventh of the FR-STA.7 budget. Demanding
    // sub-ppm precision here would assert something the estimator cannot know,
    // not something the requirement needs.
    expect(Math.abs((fit as { driftPpm: number }).driftPpm - DRIFT_PPM)).toBeLessThan(5)
  })

  it('also holds at a much larger drift', () => {
    const heavy = runSimulatedCapture(900)
    let worst = 0
    for (const { trueTMs, browserEpochMs } of heavy.checkpoints) {
      worst = Math.max(worst, Math.abs((heavy.clock.browserToTMs(browserEpochMs) as number) - trueTMs))
    }
    expect(worst).toBeLessThan(100)
  })
})

describe('DC-1 — untimestampable events yield null, never a guess', () => {
  it('returns null for the browser domain before any calibration', () => {
    const clock = new CaptureClock({ originHr: 0n, originEpochMs: 0 })
    expect(clock.isBrowserCalibrated).toBe(false)
    expect(clock.browserToTMs(1_700_000_000_000)).toBeNull()
  })

  it('returns null for CDP MonotonicTime with no bridge sample', () => {
    const clock = new CaptureClock({ originHr: 0n, originEpochMs: 0 })
    clock.addBrowserSample({ sentTMs: 0, receivedTMs: 10, browserEpochMs: 1_700_000_000_000 })
    // Browser domain is calibrated, but the monotonic bridge is not — and the
    // two are different clocks, so this must still refuse rather than reuse.
    expect(clock.monotonicToTMs(12345.678)).toBeNull()
  })

  it('returns null for non-finite inputs on every converter', () => {
    const clock = new CaptureClock({ originHr: 0n, originEpochMs: 0 })
    clock.addBrowserSample({ sentTMs: 0, receivedTMs: 10, browserEpochMs: 1_700_000_000_000 })
    clock.addMonotonicBridge(1000, 1_700_000_000)
    expect(clock.browserToTMs(Number.NaN)).toBeNull()
    expect(clock.monotonicToTMs(Number.NaN)).toBeNull()
    expect(clock.wallToTMs(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('ignores a malformed sample rather than poisoning the fit', () => {
    const clock = new CaptureClock({ originHr: 0n, originEpochMs: 0 })
    clock.addBrowserSample({ sentTMs: 10, receivedTMs: 0, browserEpochMs: 1_700_000_000_000 })
    clock.addBrowserSample({ sentTMs: 0, receivedTMs: 10, browserEpochMs: Number.NaN })
    expect(clock.browserToTMs(1_700_000_000_000)).toBeNull()
  })
})

describe('CDP MonotonicTime bridge', () => {
  /**
   * `Network.requestWillBeSent` reports `timestamp` as seconds since an
   * arbitrary Chrome-internal origin and `wallTime` as epoch seconds, in the
   * same event. Treating the monotonic value as epoch is a ~54-year error, so
   * this asserts the conversion actually goes through the bridge.
   */
  it('converts a monotonic timestamp into T via the wallTime pairing', () => {
    const epoch0 = 1_700_000_000_000
    const monotonicOriginMs = 987_654_321
    const clock = new CaptureClock({ originHr: 0n, originEpochMs: 0 })

    for (let t = 0; t <= THIRTY_MINUTES_MS; t += SAMPLE_INTERVAL_MS) {
      clock.addBrowserSample({ sentTMs: t, receivedTMs: t + 8, browserEpochMs: epoch0 + t + 4 })
      clock.addMonotonicBridge((monotonicOriginMs + t) / 1000, (epoch0 + t) / 1000)
    }

    const at = 600_000
    const converted = clock.monotonicToTMs((monotonicOriginMs + at) / 1000)
    expect(converted).not.toBeNull()
    expect(converted as number).toBeCloseTo(at, 0)
  })
})

describe('sample retention', () => {
  it('keeps the span when pruning to the cap, so the slope stays identifiable', () => {
    const clock = new CaptureClock({ originHr: 0n, originEpochMs: 0, maxSamples: 8 })
    for (let t = 0; t <= THIRTY_MINUTES_MS; t += 10_000) {
      clock.addBrowserSample({
        sentTMs: t,
        receivedTMs: t + 5,
        browserEpochMs: browserEpochAt(t + 2.5, SKEW_MS, DRIFT_PPM)
      })
    }
    const fit = clock.stats().browser
    expect(fit).not.toBeNull()
    expect((fit as { sampleCount: number }).sampleCount).toBeLessThanOrEqual(8)
    expect((fit as { spanMs: number }).spanMs).toBeCloseTo(THIRTY_MINUTES_MS, 0)
    expect((fit as { driftPpm: number }).driftPpm).toBeCloseTo(DRIFT_PPM, 0)
  })

  it('prefers low-RTT samples when evicting', () => {
    const clock = new CaptureClock({ originHr: 0n, originEpochMs: 0, maxSamples: 4 })
    for (let i = 0; i < 20; i++) {
      const t = i * 60_000
      // Every third sample is a clean one; the rest are noisy.
      const rtt = i % 3 === 0 ? 2 : 400
      clock.addBrowserSample({
        sentTMs: t,
        receivedTMs: t + rtt,
        browserEpochMs: browserEpochAt(t + rtt / 2, SKEW_MS, DRIFT_PPM)
      })
    }
    const fit = clock.stats().browser
    expect((fit as { driftPpm: number }).driftPpm).toBeCloseTo(DRIFT_PPM, 0)
  })

  it('does not invent a drift rate from a span too short to measure one', () => {
    const clock = new CaptureClock({ originHr: 0n, originEpochMs: 0 })
    clock.addBrowserSample({ sentTMs: 0, receivedTMs: 20, browserEpochMs: 1_700_000_000_000 })
    clock.addBrowserSample({ sentTMs: 40, receivedTMs: 62, browserEpochMs: 1_700_000_000_045 })
    const fit = clock.stats().browser
    expect((fit as { slope: number }).slope).toBe(1)
  })
})

describe('host wall clock', () => {
  it('maps host epoch to T through the origin', () => {
    const clock = new CaptureClock({ originHr: 0n, originEpochMs: 1_700_000_000_000 })
    expect(clock.wallToTMs(1_700_000_000_000)).toBeCloseTo(0, 6)
    expect(clock.wallToTMs(1_700_000_005_000)).toBeCloseTo(5000, 6)
  })

  it('measures T from the hrtime origin it was given', () => {
    const origin = process.hrtime.bigint()
    const clock = new CaptureClock({ originHr: origin })
    expect(clock.hrToTMs(origin + 1_500_000n)).toBeCloseTo(1.5, 6)
    expect(clock.nowTMs()).toBeGreaterThanOrEqual(0)
  })
})
