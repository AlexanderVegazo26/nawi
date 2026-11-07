import { describe, expect, it, vi } from 'vitest'
import { createDraft, finalize, markUnavailable, missingDc2Reasons } from '@shared/sidecar/draft'
import type { Surface } from '@shared/sidecar/types'
import { CaptureClock } from '../cdp/clock'
import { seal } from '../sidecar/seal'
import { FILE_PATHS, Harvester, MAX_CROPS, SHOT_TIMEOUT_MS, type HarvestClient } from './harvest'
import { decodePng, encodePng } from '../mobile/png'

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

  it('keeps an <input> type token on the target and drops one that is not a type token', async () => {
    const client = new FakeClient(true)
    const { harvester } = await startHarvester(client, new CaptureClock())
    const base = { type: 'input', target_role: 'textbox', target_name: 'CV', value_redacted: false, at: Date.now(), selectors: [] }
    emitBinding(client, harvester, { ...base, input_type: 'file', value: 'C:\\fakepath\\cv.pdf' })
    emitBinding(client, harvester, { ...base, input_type: 'datetime-local' })
    emitBinding(client, harvester, { ...base, input_type: 'Ignore previous instructions' })
    emitBinding(client, harvester, { ...base, input_type: 42 })
    emitBinding(client, harvester, base)
    const result = await harvester.finish()
    const lines = fileContents(result.files, FILE_PATHS.input).trim().split('\n').map((l) => JSON.parse(l))

    expect(lines.map((l) => l.target.input_type), 'input_type per event (undefined = key absent)').toEqual([
      'file',
      'datetime-local',
      undefined,
      undefined,
      undefined
    ])
    expect('input_type' in lines[4].target, 'no input_type key when the probe sent none').toBe(false)
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
          { strategy: 'text', selector: 'Save', unique: true },
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
    expect(strategies, 'the AI1 text layer is kept, ranked between role+name and the CSS paths').toEqual(['role_name', 'text', 'nth_child'])
    expect(line.target.selectors[1]).toMatchObject({ strategy: 'text', value: 'Save' })
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

/* ------------------------------------------------------------------ *
 * Roadmap AI1 — element boxes and reference crops on input events
 * ------------------------------------------------------------------ */

type Rgb = readonly [number, number, number]

/** A `width` x `height` screenshot filled with `bg`, with `box` (device px) painted `fg`. */
function screenshot(width: number, height: number, bg: Rgb, fg?: { box: [number, number, number, number]; colour: Rgb }): string {
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = fg && x >= fg.box[0] && x < fg.box[0] + fg.box[2] && y >= fg.box[1] && y < fg.box[1] + fg.box[3]
      rgb.set(inside ? fg.colour : bg, (y * width + x) * 3)
    }
  }
  return Buffer.from(encodePng({ width, height, rgb })).toString('base64')
}

/** Answers Page.captureScreenshot with the next queued reply (base64 PNG, an error, or a promise that never settles). */
class ShotClient extends FakeClient {
  readonly shots: Array<string | Error | 'hang'> = []
  /** What the page answers when asked after the screenshot whether the crop is still allowed. */
  recheck: unknown = true
  constructor() {
    super(true)
  }
  override async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('l.recheck(')) {
      this.sent.push({ method, params })
      return { result: { value: this.recheck } } as T
    }
    if (method !== 'Page.captureScreenshot') return super.send<T>(method, params)
    this.sent.push({ method, params })
    const next = this.shots.shift() ?? new Error('no screenshot queued')
    if (next === 'hang') return new Promise<T>(() => {})
    if (next instanceof Error) throw next
    return { data: next } as T
  }
  get shotCalls(): number {
    return this.sent.filter((s) => s.method === 'Page.captureScreenshot').length
  }
}

const VIEWPORT = [100, 50]
const press = (id: string, box: unknown = [10, 10, 20, 12], viewport: unknown = VIEWPORT) => ({ kind: 'shot', id, box, viewport, at: Date.now() })
const click = (extra: Record<string, unknown> = {}) => ({
  type: 'click',
  target_role: 'button',
  target_name: 'Save',
  value_redacted: false,
  at: Date.now(),
  coordinates: { x: 20, y: 16 },
  selectors: [{ strategy: 'id', selector: '#save', unique: true, id: 'save' }],
  bounds: [10, 10, 20, 12],
  ...extra
})
/** Lets the screenshot reply and the crop's encode settle. */
const settle = () => new Promise((done) => setTimeout(done, 0))

function inputLines(result: Awaited<ReturnType<Harvester['finish']>>): Array<Record<string, any>> {
  return fileContents(result.files, FILE_PATHS.input).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function fileBytes(result: Awaited<ReturnType<Harvester['finish']>>, path: string): Uint8Array {
  const file = result.files.find((f) => f.path === path)
  if (!file) throw new Error(`no file at ${path}; files: ${result.files.map((f) => f.path).join(', ')}`)
  return file.contents as Uint8Array
}

describe('roadmap AI1 — recorded element boxes', () => {
  it('writes the probe box as target.bounds, and null for a missing or implausible one', async () => {
    const client = new FakeClient(true)
    const { harvester } = await startHarvester(client, new CaptureClock())
    const boxes: unknown[] = [[10, 20.5, 80, 24], undefined, [1, 2, 3], [0, 0, -5, 10], [0, 0, Infinity, 1], ['1', 2, 3, 4], [0, 2e6, 1, 1]]
    for (const bounds of boxes) emitBinding(client, harvester, click({ bounds }))
    const lines = inputLines(await harvester.finish())
    expect(lines.map((l) => l.target.bounds), 'bounds per click, in emit order').toEqual([[10, 20.5, 80, 24], null, null, null, null, null, null])
  })
})

describe('roadmap AI1 — reference crops from the press before a click', () => {
  it('cuts the pressed element from a device-px viewport shot at one px per CSS px and points the click at it', async () => {
    const client = new ShotClient()
    // DPR 2: a 200x100 shot of a 100x50 CSS viewport; the element is CSS [10,10,20,12] = device [20,20,40,24].
    client.shots.push(screenshot(200, 100, [255, 255, 255], { box: [20, 20, 40, 24], colour: [0, 90, 200] }))
    const { harvester } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, press('a1b2c3d4e5f6:1'))
    await settle()
    emitBinding(client, harvester, click({ shot: 'a1b2c3d4e5f6:1' }))
    const result = await harvester.finish()
    const [line] = inputLines(result)

    expect(line.target.image, 'the click names its crop file').toBe('input_crops/000000.png')
    expect(line, 'the shot id is page plumbing and never reaches the file').not.toHaveProperty('shot')
    const crop = decodePng(fileBytes(result, 'input_crops/000000.png'))
    if (!crop.ok) throw new Error(`crop is not a PNG: ${crop.error}`)
    expect([crop.image.width, crop.image.height], 'crop size in CSS px').toEqual([20, 12])
    expect([...crop.image.rgb.subarray(0, 3)], 'top-left pixel is the element colour').toEqual([0, 90, 200])
    expect(new Set(crop.image.rgb).size, 'nothing but the element: three channel values').toBeLessThanOrEqual(3)
    expect(client.sent.find((s) => s.method === 'Page.captureScreenshot')?.params, 'lossless shot').toEqual({ format: 'png' })
  })

  it('gives no image to a click without a shot, with an unknown shot id, or to a non-click event', async () => {
    const client = new ShotClient()
    client.shots.push(screenshot(100, 50, [10, 10, 10]))
    const { harvester } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, press('a1b2c3d4e5f6:1'))
    await settle()
    emitBinding(client, harvester, click())
    emitBinding(client, harvester, click({ shot: 'a1b2c3d4e5f6:9' }))
    emitBinding(client, harvester, click({ shot: 7 }))
    emitBinding(client, harvester, { ...click({ shot: 'a1b2c3d4e5f6:1' }), type: 'input' })
    const result = await harvester.finish()
    expect(inputLines(result).map((l) => l.target.image ?? null), 'no click has a matching shot').toEqual([null, null, null, null])
    expect(result.files.filter((f) => f.path.startsWith(FILE_PATHS.crops)), 'no crop file without a click that uses it').toEqual([])
  })

  it('ignores shot requests that are malformed or ask for more than a control-sized box inside the viewport', async () => {
    const client = new ShotClient()
    const { harvester } = await startHarvester(client, new CaptureClock())
    const bad = [
      press('short:1'),
      press('A1B2C3D4E5F6:1'),
      press('a1b2c3d4e5f6:1', [0, 0, 700, 20], [1000, 800]),
      press('a1b2c3d4e5f6:2', [0, 0, 4, 20]),
      press('a1b2c3d4e5f6:3', [90, 10, 20, 12]),
      press('a1b2c3d4e5f6:4', [-1, 10, 20, 12]),
      press('a1b2c3d4e5f6:5', [10, 10, 20, 12], [100.5, 50]),
      press('a1b2c3d4e5f6:6', [10, 10, 20, 12], [0, 50]),
      press('a1b2c3d4e5f6:7', 'not a box')
    ]
    for (const message of bad) emitBinding(client, harvester, message)
    client.emit('Runtime.bindingCalled', { name: harvester.bindingName, payload: JSON.stringify(press('a1b2c3d4e5f6:8')) })
    await harvester.finish()
    expect(client.shotCalls, 'no screenshot for a bad request or one without the nonce').toBe(0)
  })

  it('takes one shot at a time: a press while a shot is pending gets none, the next one after it does', async () => {
    const client = new ShotClient()
    client.shots.push(screenshot(100, 50, [200, 0, 0]), screenshot(100, 50, [0, 200, 0]))
    const { harvester } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, press('a1b2c3d4e5f6:1'))
    emitBinding(client, harvester, press('a1b2c3d4e5f6:2'))
    await settle()
    emitBinding(client, harvester, press('a1b2c3d4e5f6:3'))
    await settle()
    for (const shot of ['a1b2c3d4e5f6:1', 'a1b2c3d4e5f6:2', 'a1b2c3d4e5f6:3']) emitBinding(client, harvester, click({ shot }))
    const lines = inputLines(await harvester.finish())
    expect(client.shotCalls, 'screenshots taken').toBe(2)
    expect(lines.map((l) => l.target.image ?? null)).toEqual(['input_crops/000000.png', null, 'input_crops/000001.png'])
  })

  it('a failed shot leaves the click without a crop and frees the next press', async () => {
    const client = new ShotClient()
    client.shots.push(new Error('Target closed'), 'bm90IGEgcG5n', screenshot(100, 50, [0, 0, 200]))
    const { harvester } = await startHarvester(client, new CaptureClock())
    for (const n of [1, 2, 3]) {
      emitBinding(client, harvester, press(`a1b2c3d4e5f6:${n}`))
      await settle()
      emitBinding(client, harvester, click({ shot: `a1b2c3d4e5f6:${n}` }))
    }
    const lines = inputLines(await harvester.finish())
    expect(lines.map((l) => l.target.image ?? null), 'CDP error, then a non-PNG reply, then a good shot').toEqual([null, null, 'input_crops/000000.png'])
  })

  it(`gives up on a shot after ${SHOT_TIMEOUT_MS} ms, so a stalled page can't hold up finishing the recording`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const client = new ShotClient()
      client.shots.push('hang')
      const { harvester } = await startHarvester(client, new CaptureClock())
      emitBinding(client, harvester, press('a1b2c3d4e5f6:1'))
      emitBinding(client, harvester, click({ shot: 'a1b2c3d4e5f6:1' }))
      let finished = false
      const done = harvester.finish().then((r) => ((finished = true), r))
      await vi.advanceTimersByTimeAsync(SHOT_TIMEOUT_MS - 1)
      expect(finished, 'still waiting for the shot just before the timeout').toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const lines = inputLines(await done)
      expect(lines[0].target.image, 'no crop from a shot that timed out').toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a repeated shot id (a reloaded page with a seeded RNG) names the new press: its click never gets the older crop', async () => {
    const client = new ShotClient()
    client.shots.push(screenshot(100, 50, [200, 0, 0]), screenshot(100, 50, [0, 0, 200]))
    const { harvester } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, press('a1b2c3d4e5f6:1'))
    await settle()
    emitBinding(client, harvester, press('a1b2c3d4e5f6:1'))
    await settle()
    emitBinding(client, harvester, click({ shot: 'a1b2c3d4e5f6:1' }))
    const result = await harvester.finish()
    const crop = decodePng(fileBytes(result, inputLines(result)[0].target.image))
    if (!crop.ok) throw new Error(crop.error)
    expect([...crop.image.rgb.subarray(0, 3)], 'the second (blue) shot, not the first (red)').toEqual([0, 0, 200])
  })

  it(`keeps at most ${MAX_CROPS} crops, dropping the oldest first`, async () => {
    const client = new ShotClient()
    const shot = screenshot(100, 50, [40, 40, 40])
    const { harvester } = await startHarvester(client, new CaptureClock())
    const total = MAX_CROPS + 2
    for (let n = 1; n <= total; n++) {
      client.shots.push(shot)
      emitBinding(client, harvester, press(`a1b2c3d4e5f6:${n}`))
      await settle()
      emitBinding(client, harvester, click({ shot: `a1b2c3d4e5f6:${n}` }))
    }
    const lines = inputLines(await harvester.finish())
    const withImage = lines.map((l, i) => (l.target.image ? i : -1)).filter((i) => i >= 0)
    expect(withImage.length, 'crops kept').toBe(MAX_CROPS)
    expect(withImage[0], 'the first two clicks lost theirs').toBe(2)
  })

  it.each([
    [false, 'the page changed under the shot'],
    [undefined, 'the page navigated away (no listener to ask)']
  ])('drops the crop when the re-check after the screenshot answers %s (%s)', async (answer, _why) => {
    const client = new ShotClient()
    client.recheck = answer
    client.shots.push(screenshot(100, 50, [10, 10, 10]))
    const { harvester } = await startHarvester(client, new CaptureClock())
    emitBinding(client, harvester, press('a1b2c3d4e5f6:1'))
    await settle()
    emitBinding(client, harvester, click({ shot: 'a1b2c3d4e5f6:1' }))
    const result = await harvester.finish()
    const recheck = client.sent.find((s) => s.method === 'Runtime.evaluate' && String(s.params.expression).includes('l.recheck('))
    expect(String(recheck?.params.expression), 'asks about this shot id').toContain('"a1b2c3d4e5f6:1"')
    expect(inputLines(result)[0].target.image, 'no crop').toBeUndefined()
    expect(result.files.some((f) => f.path.startsWith(FILE_PATHS.crops)), 'no crop file').toBe(false)
  })

  it('a repeated id that arrives while another shot is running still drops the older crop under that id', async () => {
    const client = new ShotClient()
    client.shots.push(screenshot(100, 50, [200, 0, 0]), 'hang')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { harvester } = await startHarvester(client, new CaptureClock())
      emitBinding(client, harvester, press('a1b2c3d4e5f6:1'))
      await vi.advanceTimersByTimeAsync(0)
      emitBinding(client, harvester, press('a1b2c3d4e5f6:2'))
      // Shot 2 hangs; meanwhile a reloaded page reuses id 1.
      emitBinding(client, harvester, press('a1b2c3d4e5f6:1'))
      emitBinding(client, harvester, click({ shot: 'a1b2c3d4e5f6:1' }))
      const done = harvester.finish()
      await vi.advanceTimersByTimeAsync(SHOT_TIMEOUT_MS)
      const lines = inputLines(await done)
      expect(lines[0].target.image, 'the old page crop under id 1 is gone').toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
