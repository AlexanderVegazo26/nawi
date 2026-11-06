import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validSidecar } from '@shared/sidecar/__fixtures__/sidecar'
import type { SidecarRead } from '@shared/sidecar/types'
import { parseFlow, formatFlowErrors } from '@shared/flow'
import { flowFromSidecar, NoInputEventsError } from './flow-export'

/**
 * `export_flow` end to end below the MCP layer: a revision directory on disk
 * with an `input_events.ndjson` written in the harvest's line shape.
 */

let dir: string

const SEARCH = {
  role: 'searchbox',
  accessible_name: 'Search invoices',
  text: null,
  bounds: null,
  selectors: [{ strategy: 'testid', value: '[data-testid="invoice-search"]', stability: 1 }]
}
const OPEN = {
  role: 'link',
  accessible_name: 'INV-0042',
  text: null,
  bounds: null,
  selectors: [{ strategy: 'role_name', value: 'role=link[name="INV-0042"]', stability: 0.8 }]
}

const LINES = [
  { t_ms: 100, type: 'click', coordinates: { x: 4, y: 4 }, target: SEARCH, value_redacted: false },
  { t_ms: 200, type: 'input', coordinates: null, target: { ...SEARCH, text: '42' }, value_redacted: false },
  { t_ms: 300, type: 'keydown', coordinates: null, target: SEARCH, value_redacted: false, key: 'Enter' },
  { t_ms: 400, type: 'scroll', coordinates: { x: 0, y: 300 }, target: null, value_redacted: false },
  { t_ms: 500, type: 'click', coordinates: { x: 9, y: 9 }, target: OPEN, value_redacted: false }
]

function recording(overrides: Partial<SidecarRead['state_layer']> = {}): SidecarRead {
  const base = validSidecar({ kind: 'recording', duration_ms: 1000 })
  return { ...base, state_layer: { ...base.state_layer, ...overrides } }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nawi-flow-export-'))
  // A corrupt line in the middle must not stop the export (same rule as get_state_layer).
  const text = [...LINES.slice(0, 2).map((l) => JSON.stringify(l)), '{not json', ...LINES.slice(2).map((l) => JSON.stringify(l))]
  await fs.writeFile(join(dir, 'input_events.ndjson'), `${text.join('\n')}\n`)
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('flowFromSidecar', () => {
  it('turns a revision\'s input_events.ndjson into flow YAML that parses', async () => {
    const out = await flowFromSidecar({ revisionDir: dir, sidecar: recording(), revision: 'v1', name: 'Open invoice 42' })

    expect(out).toMatchObject({
      revision: 'v1',
      file_name: 'open-invoice-42.nawi.yaml',
      steps: 3,
      events: 5,
      skipped: { focus_click: 1, scroll: 1 }
    })
    const parsed = parseFlow(out.flow_yaml)
    expect(parsed.ok, parsed.ok ? '' : `${formatFlowErrors(parsed.errors)}\n${out.flow_yaml}`).toBe(true)
    if (!parsed.ok) return
    expect(parsed.flow.target).toEqual({ kind: 'browser', url: 'https://app.example.com/checkout' })
    expect(parsed.flow.steps.map((s) => s.action)).toEqual(['fill', 'press', 'click'])
  })

  it('reads inline DC-4 input_events arrays too, and names an unnamed flow after the capture time', async () => {
    const out = await flowFromSidecar({
      revisionDir: dir,
      sidecar: recording({ input_events: LINES as never }),
      revision: 'v2'
    })
    expect(out.steps).toBe(3)
    expect(out.file_name).toBe('recording-2026-08-28t14-03-11-204z.nawi.yaml')
    expect(out.flow_yaml).toContain('name: Recording 2026-08-28T14:03:11.204Z')
  })

  it('uses a desktop target when the surface has no URL', async () => {
    const base = recording({ input_events: [] })
    const out = await flowFromSidecar({
      revisionDir: dir,
      sidecar: { ...base, surface: { ...base.surface, type: 'desktop', url: null, app: 'Finder' } },
      revision: 'v1',
      name: 'x'
    })
    expect(out.flow_yaml).toContain('kind: desktop')
    expect(out.flow_yaml).toContain('app: Finder')
    expect(out.warnings).toContain('No replayable steps were found in this recording.')
  })

  it.each([
    ['null', null],
    ['blank', '  ']
  ])('keeps a browser recording whose start URL is %s a browser flow on about:blank, and says so', async (_label, url) => {
    const base = recording({ input_events: LINES as never })
    const out = await flowFromSidecar({
      revisionDir: dir,
      sidecar: { ...base, surface: { ...base.surface, type: 'browser', url, app: 'Chrome' } },
      revision: 'v3',
      name: 'No start URL'
    })
    const parsed = parseFlow(out.flow_yaml)
    expect(parsed.ok, parsed.ok ? '' : `${formatFlowErrors(parsed.errors)}\n${out.flow_yaml}`).toBe(true)
    if (!parsed.ok) return
    expect(
      parsed.flow.target,
      `a browser surface with url ${JSON.stringify(url)} must stay replayable (CSS/testid steps), got:\n${out.flow_yaml}`
    ).toEqual({ kind: 'browser', url: 'about:blank' })
    expect(parsed.flow.steps.map((s) => s.action)).toEqual(['fill', 'press', 'click'])
    expect(out.warnings[0], `warnings: ${JSON.stringify(out.warnings)}`).toBe(
      "The recording didn't save the page it started on, so the flow starts on about:blank; " +
        'set target.url to that page before replaying.'
    )
  })

  it('does not warn about a missing start URL when the browser recording has one', async () => {
    const out = await flowFromSidecar({ revisionDir: dir, sidecar: recording(), revision: 'v1', name: 'x' })
    expect(out.warnings.some((w) => w.includes('about:blank')), `warnings: ${JSON.stringify(out.warnings)}`).toBe(false)
  })

  it('reports why there is nothing to export when input events were not harvested', async () => {
    const sidecar = recording({
      input_events: null,
      unavailable: [{ source: 'input_events', reason: 'unsupported_surface' }]
    })
    const err = await flowFromSidecar({ revisionDir: dir, sidecar, revision: 'v1' }).catch((e: unknown) => e)
    expect(err, 'expected a NoInputEventsError').toBeInstanceOf(NoInputEventsError)
    expect((err as NoInputEventsError).reason).toBe('unsupported_surface')
  })

  it('reads at most maxEvents input events and says the flow covers only the start', async () => {
    const out = await flowFromSidecar({ revisionDir: dir, sidecar: recording(), revision: 'v1', name: 'x', maxEvents: 2 })
    expect(out.events, 'reading must stop at the cap').toBe(2)
    expect(out.warnings[0]).toBe('Only the first 2 input events were read; the flow covers the start of the recording only.')
  })

  it('refuses an input_events path that leaves the revision directory, instead of returning an empty flow', async () => {
    const err = await flowFromSidecar({
      revisionDir: join(dir, 'nested'),
      sidecar: recording({ input_events: { path: '../input_events.ndjson', count: 5 } }),
      revision: 'v1',
      name: 'x'
    }).catch((e: unknown) => e)
    expect(err, 'a "../" path must be refused, not read').toBeInstanceOf(NoInputEventsError)
    expect((err as NoInputEventsError).reason).toBe('unreadable')
  })

  it('says the events file is unreadable when the sidecar names one that is missing', async () => {
    const err = await flowFromSidecar({
      revisionDir: dir,
      sidecar: recording({ input_events: { path: 'gone.ndjson', count: 5 } }),
      revision: 'v1',
      name: 'x'
    }).catch((e: unknown) => e)
    expect(err, 'a missing input_events file must not export as an empty flow').toBeInstanceOf(NoInputEventsError)
    expect((err as NoInputEventsError).reason).toBe('unreadable')
  })

  it('says the events file is unreadable when the sidecar names a directory, instead of returning an empty flow', async () => {
    // access(R_OK) passes for a directory; the read itself fails (EISDIR) once streaming starts.
    await fs.mkdir(join(dir, 'events-dir.ndjson'), { recursive: true })
    const err = await flowFromSidecar({
      revisionDir: dir,
      sidecar: recording({ input_events: { path: 'events-dir.ndjson', count: 5 } }),
      revision: 'v1',
      name: 'x'
    }).catch((e: unknown) => e)
    expect(err, 'an input_events path that is a directory must not export as an empty flow').toBeInstanceOf(NoInputEventsError)
    expect((err as NoInputEventsError).reason).toBe('unreadable')
  })
})
