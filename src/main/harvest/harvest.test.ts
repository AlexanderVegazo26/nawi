import { describe, expect, it } from 'vitest'
import { createDraft, finalize, markUnavailable, missingDc2Reasons } from '@shared/sidecar/draft'
import type { Surface } from '@shared/sidecar/types'
import { CaptureClock } from '../cdp/clock'
import { seal } from '../sidecar/seal'
import { FILE_PATHS, Harvester, type HarvestClient } from './harvest'

const SURFACE: Surface = {
  type: 'browser',
  app: 'Chromium',
  url: 'https://example.test/',
  os: 'win32',
  locale: 'en-US',
  viewport: { w: 1280, h: 800, dpr: 1 },
  displays: []
}

const CAPTURE_ID = '11111111-2222-4333-8444-555555555555'

type Listener = (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void

/**
 * A CDP double. Deliberately not a mock of `CdpClient` — it answers the exact
 * methods `Harvester.start` sends and lets a test push events at it, which is
 * what the DC-1 path needs and what a real browser makes slow and imprecise.
 */
class FakeClient implements HarvestClient {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = []
  private readonly listeners = new Map<string, Set<Listener>>()
  /** When false, the clock calibration round trip returns junk and never calibrates. */
  constructor(private readonly calibrates: boolean) {}

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    this.sent.push({ method, params })
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression ?? '')
      if (expression.includes('performance.timeOrigin')) {
        return (this.calibrates
          ? { result: { value: Date.now() } }
          : { result: { value: 'not-a-number' } }) as T
      }
      if (expression.includes('markSecrets')) {
        return { result: { value: { marked: 0, total: 0 } } } as T
      }
      return { result: { value: undefined } } as T
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } } as T
    if (method === 'DOM.querySelectorAll') return { nodeIds: [] } as T
    if (method === 'DOMSnapshot.captureSnapshot') return { documents: [], strings: [] } as T
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] } as T
    return {} as T
  }

  on(method: string, listener: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(listener)
    this.listeners.set(method, set)
    return () => set.delete(listener)
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.listeners.get(method) ?? []) listener({ method, params })
  }

  get listenerCount(): number {
    let n = 0
    for (const set of this.listeners.values()) n += set.size
    return n
  }
}

function newDraft() {
  return createDraft({ capture_id: CAPTURE_ID, kind: 'screenshot', surface: SURFACE, generator: 'test' })
}

async function startHarvester(client: FakeClient, clock: CaptureClock) {
  const draft = newDraft()
  const harvester = await Harvester.start({ client, sessionId: 'S1', clock, draft })
  return { harvester, draft }
}

/**
 * Emit a binding call the way the injected listener would.
 *
 * The binding name and the nonce are per-session (F8), so a test cannot name
 * either as a constant any more — it has to ask the harvester. A payload without
 * the nonce is dropped on purpose, which is what `forgesWithout` below exercises.
 */
function emitBinding(
  client: FakeClient,
  harvester: Harvester,
  payload: Record<string, unknown> | string
): void {
  client.emit('Runtime.bindingCalled', {
    name: harvester.bindingName,
    payload:
      typeof payload === 'string'
        ? payload
        : JSON.stringify({ ...payload, nonce: harvester.bindingNonce })
  })
}

function fileContents(files: Array<{ path: string; contents: string | Uint8Array }>, path: string): string {
  const file = files.find((f) => f.path === path)
  if (!file) throw new Error(`no file at ${path}`)
  return file.contents as string
}

describe('Harvester — setup', () => {
  it('installs the probe, the binding and the listener before subscribing', async () => {
    const client = new FakeClient(true)
    const { harvester } = await startHarvester(client, new CaptureClock())
    const methods = client.sent.map((s) => s.method)

    expect(methods).toContain('Runtime.addBinding')
    expect(client.sent.find((s) => s.method === 'Runtime.addBinding')!.params.name).toBe(
      harvester.bindingName
    )
    // Per-session and unguessable, not the old fixed `__nawiEmit`.
    expect(harvester.bindingName).toMatch(/^__nawiEmit_[0-9a-f]{32}$/)
    // The already-parsed document needs an explicit evaluate; the
    // add-on-new-document call alone silently does nothing for it.
    expect(methods.filter((m) => m === 'Page.addScriptToEvaluateOnNewDocument').length).toBeGreaterThanOrEqual(2)
    await harvester.finish()
  })

  it('unsubscribes every listener on finish, so a later event cannot mutate a written capture', async () => {
    const client = new FakeClient(true)
    const { harvester } = await startHarvester(client, new CaptureClock())
    expect(client.listenerCount).toBeGreaterThan(0)
    await harvester.finish()
    expect(client.listenerCount).toBe(0)
  })
})

describe('DC-1 — an unresolvable timestamp means the event is absent, not zeroed', () => {
  it('drops a console entry when the browser clock never calibrated', async () => {
    const clock = new CaptureClock()
    const client = new FakeClient(false)
    const { harvester, draft } = await startHarvester(client, clock)

    // Precondition: with no usable calibration there is no fit to convert against.
    expect(clock.isBrowserCalibrated).toBe(false)
    expect(clock.browserToTMs(Date.now())).toBeNull()

    client.emit('Runtime.consoleAPICalled', {
      type: 'error',
      timestamp: Date.now(),
      args: [{ value: 'UNRESOLVABLE-CONSOLE-MARKER' }]
    })

    const result = await harvester.finish()
    const contents = fileContents(result.files, FILE_PATHS.console)

    expect(result.droppedForTimestamp.console).toBe(1)
    // Absent from the bytes …
    expect(contents).not.toContain('UNRESOLVABLE-CONSOLE-MARKER')
    expect(contents).toBe('')
    // … and never emitted at t=0 as a stand-in.
    expect(contents).not.toContain('"t_ms":0')
    // … and the ref's count agrees with the file, so nothing is counted but missing.
    expect(draft.state_layer.console_log!.count).toBe(0)
  })

  it('keeps the same entry once the clock IS calibrated', async () => {
    const clock = new CaptureClock()
    const client = new FakeClient(true)
    const { harvester, draft } = await startHarvester(client, clock)
    expect(clock.isBrowserCalibrated).toBe(true)

    client.emit('Runtime.consoleAPICalled', {
      type: 'error',
      timestamp: Date.now(),
      args: [{ value: 'RESOLVABLE-CONSOLE-MARKER' }]
    })

    const result = await harvester.finish()
    const contents = fileContents(result.files, FILE_PATHS.console)
    expect(result.droppedForTimestamp.console).toBe(0)
    expect(contents).toContain('RESOLVABLE-CONSOLE-MARKER')
    expect(draft.state_layer.console_log!.count).toBe(1)
  })

  it('the NDJSON line count always equals the ref count', async () => {
    const clock = new CaptureClock()
    const client = new FakeClient(true)
    const { harvester, draft } = await startHarvester(client, clock)
    for (let i = 0; i < 5; i++) {
      client.emit('Log.entryAdded', {
        entry: { timestamp: Date.now(), level: 'warning', text: `entry-${i}` }
      })
    }
    const result = await harvester.finish()
    const lines = fileContents(result.files, FILE_PATHS.console).trimEnd().split('\n').filter(Boolean)
    expect(lines).toHaveLength(draft.state_layer.console_log!.count)
    expect(lines).toHaveLength(5)
  })

  it('drops an input event with an unresolvable timestamp', async () => {
    const client = new FakeClient(false)
    const { harvester, draft } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, ({ type: 'click', at: Date.now(), target_role: 'button', selectors: [] })
    )
    const result = await harvester.finish()
    expect(result.droppedForTimestamp.input).toBe(1)
    expect(draft.state_layer.input_events!.count).toBe(0)
  })

  it('ignores a junk binding payload without taking the harvest down', async () => {
    const client = new FakeClient(true)
    const { harvester, draft } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, 'not json{')
    client.emit('Runtime.bindingCalled', { name: 'someone-elses-binding', payload: '{}' })
    const result = await harvester.finish()
    expect(draft.state_layer.input_events!.count).toBe(0)
    expect(result.files.length).toBeGreaterThan(0)
  })
})

describe('FR-STA.4 / FR-SEC.2 — input event shape', () => {
  it('emits the acceptance shape and never invents a value for a redacted field', async () => {
    const client = new FakeClient(true)
    const { harvester } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, ({
        type: 'input',
        target_role: 'textbox',
        target_name: null,
        value_redacted: true,
        at: Date.now(),
        coordinates: null,
        selectors: [{ strategy: 'id', selector: '#pw', unique: true, id: 'pw' }]
      })
    )
    const result = await harvester.finish()
    const line = JSON.parse(fileContents(result.files, FILE_PATHS.input).trim())

    expect(line).toMatchObject({ type: 'input', value_redacted: true })
    // The role lives under `target` in DC-4, not at the top level.
    expect(line.target.role).toBe('textbox')
    expect(line.target.text).toBeNull()
    expect(typeof line.t_ms).toBe('number')
  })

  it('converts hyphenated selector strategies to DC-4 underscored ones', async () => {
    const client = new FakeClient(true)
    const { harvester } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, ({
        type: 'click',
        target_role: 'button',
        value_redacted: false,
        at: Date.now(),
        selectors: [
          { strategy: 'role-name', selector: 'role=button[name="Save"]', unique: true },
          { strategy: 'nth-child', selector: 'div:nth-of-type(1)', unique: true }
        ]
      })
    )
    const result = await harvester.finish()
    const line = JSON.parse(fileContents(result.files, FILE_PATHS.input).trim())
    const strategies = line.target.selectors.map((s: { strategy: string }) => s.strategy)
    // A hyphenated strategy would be rejected by parseSidecarStrict at the writer.
    expect(strategies).toContain('role_name')
    expect(strategies).toContain('nth_child')
    expect(strategies.join(',')).not.toContain('-')
  })

  it('keeps a value for a non-secret field, so suppression is targeted not blanket', async () => {
    const client = new FakeClient(true)
    const { harvester } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, ({
        type: 'input',
        target_role: 'textbox',
        value_redacted: false,
        value: 'ordinary text',
        at: Date.now(),
        selectors: []
      })
    )
    const result = await harvester.finish()
    const line = JSON.parse(fileContents(result.files, FILE_PATHS.input).trim())
    expect(line.target.text).toBe('ordinary text')
    expect(line.value_redacted).toBe(false)
  })
})

describe('DC-2 — an unsupported surface yields null AND a reason', () => {
  it('records both halves for a desktop capture with no CDP session at all', () => {
    const draft = createDraft({
      capture_id: CAPTURE_ID,
      kind: 'screenshot',
      surface: { ...SURFACE, type: 'desktop', url: null, app: 'Notepad' },
      generator: 'test'
    })

    for (const source of [
      'dom_snapshot',
      'accessibility_tree',
      'console_log',
      'network_har',
      'input_events'
    ] as const) {
      markUnavailable(draft, source, 'unsupported_surface')
    }

    expect(missingDc2Reasons(draft)).toEqual([])
    const sidecar = finalize(draft)

    for (const source of [
      'dom_snapshot',
      'accessibility_tree',
      'console_log',
      'network_har',
      'input_events'
    ] as const) {
      // Null — and the key is genuinely present, not dropped by JSON.stringify.
      expect(sidecar.state_layer[source]).toBeNull()
      expect(Object.keys(JSON.parse(JSON.stringify(sidecar)).state_layer)).toContain(source)
      // …and the matching reason. Both halves, never one.
      expect(sidecar.state_layer.unavailable).toContainEqual({
        source,
        reason: 'unsupported_surface'
      })
    }
  })

  it('refuses to finalize a source that is null with no reason', () => {
    const draft = newDraft()
    expect(missingDc2Reasons(draft).length).toBe(5)
    expect(() => finalize(draft)).toThrow(/DC-2 violation/)
  })

  it('a harvester marking one source unavailable still seals', async () => {
    const client = new FakeClient(true)
    const { harvester, draft } = await startHarvester(client, new CaptureClock())
    await harvester.finish()
    // finish() set the four it can always produce; the DOM was never captured.
    harvester.markUnavailable('dom_snapshot', 'capture_failed')
    harvester.markUnavailable('accessibility_tree', 'capture_failed')
    expect(() => seal(draft, [])).not.toThrow()
    expect(draft.state_layer.dom_snapshot).toBeNull()
  })
})

/* ------------------------------------------------------------------------- *
 * F8 — the page can call the binding, so raise the cost of forging entries.
 *
 * This is agent-context poisoning, not disclosure: the state layer is built to
 * be read by an agent, so a forged `input_events` line is an indirect
 * prompt-injection channel. It cannot be fully closed page-side — the binding
 * must be callable from the page — so these assert blast-radius reduction, not
 * authentication.
 * ------------------------------------------------------------------------- */

describe('F8 — state-layer entries cannot be forged against a known binding name', () => {
  it('uses a different binding name and nonce for every session', async () => {
    const a = await startHarvester(new FakeClient(true), new CaptureClock())
    const b = await startHarvester(new FakeClient(true), new CaptureClock())
    expect(a.harvester.bindingName).not.toBe(b.harvester.bindingName)
    expect(a.harvester.bindingNonce).not.toBe(b.harvester.bindingNonce)
    await a.harvester.finish()
    await b.harvester.finish()
  })

  it('rejects a payload that does not carry this session‘s nonce', async () => {
    const client = new FakeClient(true)
    const { harvester, draft } = await startHarvester(client, new CaptureClock())

    // A page that discovered the binding name but not the nonce.
    client.emit('Runtime.bindingCalled', {
      name: harvester.bindingName,
      payload: JSON.stringify({
        type: 'input',
        target_role: 'textbox',
        value: 'FORGED-BY-THE-PAGE',
        value_redacted: false,
        at: Date.now(),
        selectors: []
      })
    })
    // …and one with a guessed-wrong nonce.
    client.emit('Runtime.bindingCalled', {
      name: harvester.bindingName,
      payload: JSON.stringify({ type: 'input', nonce: 'not-the-nonce', at: Date.now(), selectors: [] })
    })

    const result = await harvester.finish()
    expect(fileContents(result.files, FILE_PATHS.input)).not.toContain('FORGED-BY-THE-PAGE')
    expect(draft.state_layer.input_events!.count).toBe(0)
  })

  it('still accepts a genuine payload, and does not leak the nonce into the file', async () => {
    // The other half: a nonce check that is too strict silently empties
    // input_events, which would look like a passing security test.
    const client = new FakeClient(true)
    const { harvester, draft } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, {
      type: 'input',
      target_role: 'textbox',
      value: 'GENUINE-ENTRY',
      value_redacted: false,
      at: Date.now(),
      selectors: []
    })
    const result = await harvester.finish()
    const contents = fileContents(result.files, FILE_PATHS.input)
    expect(contents).toContain('GENUINE-ENTRY')
    expect(draft.state_layer.input_events!.count).toBe(1)
    // The nonce is a transport detail; writing it to disk would publish it.
    expect(contents).not.toContain(harvester.bindingNonce)
    expect(contents).not.toContain('nonce')
  })
})
