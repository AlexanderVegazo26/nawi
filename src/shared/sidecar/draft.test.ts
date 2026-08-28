import { describe, expect, it } from 'vitest'
import { createDraft, finalize, markUnavailable, missingDc2Reasons, setSource } from './draft'
import { parseSidecarStrict } from './schema'
import type { Surface } from './types'

const surface: Surface = {
  type: 'desktop',
  app: 'Notepad',
  url: null,
  os: 'Windows 11',
  locale: 'en-US',
  viewport: { w: 1920, h: 1080, dpr: 1 },
  displays: [{ id: 'd1', bounds: [0, 0, 1920, 1080], dpr: 1 }]
}

const draft = () =>
  createDraft({
    capture_id: '11111111-2222-4333-8444-555555555555',
    kind: 'screenshot',
    surface,
    created_at: '2026-08-28T14:03:11.204Z',
    generator: 'nawi/0.1.0'
  })

describe('DC-2 — the state layer is optional to consume, never optional to attempt', () => {
  it('emits dom_snapshot: null AND an unavailable entry on an unsupported surface — never an absent key', () => {
    const d = draft()
    for (const source of ['dom_snapshot', 'accessibility_tree', 'console_log', 'network_har', 'input_events'] as const) {
      markUnavailable(d, source, 'unsupported_surface')
    }

    const sidecar = finalize(d)
    const serialized = JSON.parse(JSON.stringify(sidecar))

    // Presence, not value: `toBeNull()` also passes for a key that vanished in
    // serialization, which is the exact failure DC-2 names.
    expect('dom_snapshot' in serialized.state_layer).toBe(true)
    expect(serialized.state_layer.dom_snapshot).toBeNull()

    expect(serialized.state_layer.unavailable).toContainEqual({
      source: 'dom_snapshot',
      reason: 'unsupported_surface'
    })

    expect(parseSidecarStrict(serialized).ok).toBe(true)
  })

  it('refuses to finalize a source that is null with no reason', () => {
    const d = draft()
    markUnavailable(d, 'dom_snapshot', 'unsupported_surface')

    expect(missingDc2Reasons(d)).toEqual([
      'accessibility_tree',
      'console_log',
      'network_har',
      'input_events'
    ])
    expect(() => finalize(d)).toThrow(/DC-2 violation/)
  })

  it('clears the unavailable entry when a retry succeeds, so the sidecar cannot contradict itself', () => {
    const d = draft()
    markUnavailable(d, 'console_log', 'capture_failed')
    setSource(d, 'console_log', { path: 'console.ndjson', count: 4 })

    expect(d.state_layer.unavailable.some((u) => u.source === 'console_log')).toBe(false)
    expect(d.state_layer.console_log).toEqual({ path: 'console.ndjson', count: 4 })
  })
})

describe('draft → sidecar', () => {
  it('produces a strict-valid sidecar and does not alias the draft it came from', () => {
    const d = draft()
    for (const source of ['dom_snapshot', 'accessibility_tree', 'console_log', 'network_har', 'input_events'] as const) {
      markUnavailable(d, source, 'unsupported_surface')
    }
    const sidecar = finalize(d, { supersedes: 'v1' })

    expect(parseSidecarStrict(sidecar).ok).toBe(true)
    expect(sidecar.supersedes).toBe('v1')
    expect(sidecar.schema_version).toBe('1.0')

    // A later mutation of the draft must not reach a sidecar already handed off.
    d.state_layer.agent_trace.push({
      t_ms: 1,
      agent_id: 'a',
      tool: 't',
      arguments: {},
      result: 'ok',
      reasoning_summary: null
    })
    expect(sidecar.state_layer.agent_trace).toHaveLength(0)
  })
})
