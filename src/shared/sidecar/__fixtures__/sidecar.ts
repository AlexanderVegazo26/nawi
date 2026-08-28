import { SCHEMA_VERSION } from '../version'
import type { Sidecar } from '../types'

/**
 * A minimal but *complete* DC-4 sidecar — every required key present, including
 * the DC-2 source keys that are null with a matching `unavailable[]` reason.
 *
 * Test-only. Nothing in the app imports it, so it never reaches a bundle.
 */
export function validSidecar(overrides: Partial<Sidecar> = {}): Sidecar {
  return {
    schema_version: SCHEMA_VERSION,
    capture_id: '11111111-2222-4333-8444-555555555555',
    kind: 'screenshot',
    created_at: '2026-08-28T14:03:11.204Z',
    duration_ms: null,
    supersedes: null,
    surface: {
      type: 'browser',
      app: 'Google Chrome',
      url: 'https://app.example.com/checkout',
      os: 'Windows 11',
      locale: 'en-US',
      viewport: { w: 1512, h: 856, dpr: 2 },
      displays: [{ id: 'd1', bounds: [0, 0, 3024, 1712], dpr: 2 }]
    },
    pixel_layer: {
      frames: [{ t_ms: 0, path: 'frames/000000.png', sha256: 'abc' }],
      video: null,
      audio_tracks: []
    },
    state_layer: {
      dom_snapshot: { t_ms: 0, path: 'dom/000000.json' },
      accessibility_tree: { t_ms: 0, path: 'ax/000000.json' },
      console_log: { path: 'console.ndjson', count: 3 },
      network_har: { path: 'network.har', truncated: false },
      input_events: { path: 'input_events.ndjson', count: 12 },
      agent_trace: [],
      unavailable: []
    },
    derived: { transcript: null, ocr: null, summary: null, tags: [] },
    redactions: [],
    provenance: { ai_edited_regions: [], generator: 'nawi/0.1.0' },
    ...overrides
  }
}
