import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validSidecar } from '@shared/sidecar/__fixtures__/sidecar'
import type { SidecarRead } from '@shared/sidecar/types'
import { parseFlow, formatFlowErrors } from '@shared/flow'
import { flowFromSidecar, NoInputEventsError } from './flow-export'
import { ToolError } from './errors'
import { pngFromRows } from '../mobile/fixtures/make-png'
import { readFlowAsset } from '../flow-run'

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

/* ------------------------------------------------------------------ *
 * Writing the flow and its reference crops (roadmap AI1b-3b)
 * ------------------------------------------------------------------ */

/** A real 2x2 RGB PNG, distinct per seed. */
const png = (seed: number): Uint8Array => pngFromRows(2, 2, 8, 2, [0, 1].map((r) => Uint8Array.from([...Array.from({ length: 6 }, (_, i) => (seed * 31 + r * 7 + i) & 255)])))

const SAVE = {
  role: 'button',
  accessible_name: 'Save',
  text: null,
  bounds: [20, 20, 80, 30],
  selectors: [{ strategy: 'id', value: '#save', stability: 0.9 }]
}
const NAME = {
  role: 'textbox',
  accessible_name: 'Name',
  text: null,
  bounds: [20, 60, 200, 30],
  selectors: [{ strategy: 'id', value: '#name', stability: 0.9 }]
}

describe('flowFromSidecar with an output path', () => {
  let rev: string
  let home: string
  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    const err = await p.then(() => undefined, (e: unknown) => e)
    expect(err, 'expected a ToolError').toBeInstanceOf(ToolError)
    return (err as ToolError).code
  }
  const write = (output: string, events: unknown[], extra: { overwrite?: boolean; name?: string } = {}) =>
    flowFromSidecar({
      revisionDir: rev,
      sidecar: recording({ input_events: events as never }),
      revision: 'v1',
      name: extra.name ?? 'Save the name',
      output,
      overwrite: extra.overwrite,
      roots: [home]
    })
  const clickName = { t_ms: 10, type: 'click', target: { ...NAME, image: 'input_crops/000000.png' }, value_redacted: false }
  const typeName = { t_ms: 20, type: 'input', target: { ...NAME, text: 'Ada' }, value_redacted: false }
  const clickSave = { t_ms: 30, type: 'click', target: { ...SAVE, image: 'input_crops/000001.png' }, value_redacted: false }

  beforeAll(async () => {
    rev = await fs.mkdtemp(join(tmpdir(), 'nawi-flow-export-rev-'))
    home = await fs.mkdtemp(join(tmpdir(), 'nawi-flow-export-home-'))
    await fs.mkdir(join(rev, 'input_crops'))
    await fs.writeFile(join(rev, 'input_crops', '000000.png'), png(1))
    await fs.writeFile(join(rev, 'input_crops', '000001.png'), png(2))
    await fs.writeFile(join(rev, 'input_crops', '000002.png'), 'not a png')
    await fs.writeFile(join(home, 'outside.png'), png(3))
    await fs.symlink(join(home, 'outside.png'), join(rev, 'input_crops', '000003.png'))
  })

  afterAll(async () => {
    await fs.rm(rev, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  it('writes the flow and copies each step\'s crop next to it, where the replayer\'s loader reads it back', async () => {
    const file = join(home, 'save-name.nawi.yaml')
    const out = await write(file, [clickName, typeName, clickSave])

    expect(out, 'reply names the written file and crop count').toMatchObject({ file: await fs.realpath(file), file_name: 'save-name.nawi.yaml', crops: 2, steps: 2 })
    const onDisk = await fs.readFile(file, 'utf8')
    expect(onDisk, 'the file holds exactly the returned YAML').toBe(out.flow_yaml)
    const parsed = parseFlow(onDisk)
    expect(parsed.ok, parsed.ok ? '' : `${formatFlowErrors(parsed.errors)}\n${onDisk}`).toBe(true)
    if (!parsed.ok) return
    const images = parsed.flow.steps.map((s) => ('target' in s ? s.target?.image : undefined))
    expect(images, 'the fill takes its focus click\'s crop; the button keeps its own').toEqual(['save-name.crops/000000.png', 'save-name.crops/000001.png'])
    for (const [i, image] of images.entries()) {
      const bytes = await readFlowAsset(file, image!)
      expect(Buffer.from(bytes).equals(Buffer.from(png(i + 1))), `${image} must be a byte copy of input_crops/00000${i}.png`).toBe(true)
    }
  })

  it('refuses to replace an existing flow or another export\'s crops unless overwrite is set, and then drops stale crops', async () => {
    const file = join(home, 'again.nawi.yaml')
    await write(file, [clickName, typeName, clickSave])
    const before = await fs.readFile(file, 'utf8')

    expect(await codeOf(write(file, [clickSave])), 'existing file, no overwrite').toBe('INVALID_ARGUMENTS')
    expect(await fs.readFile(file, 'utf8'), 'a refused export changes nothing').toBe(before)
    await fs.rm(file)
    expect(await codeOf(write(file, [clickSave])), 'crops folder of an earlier export, no overwrite').toBe('INVALID_ARGUMENTS')

    const out = await write(file, [clickSave], { overwrite: true })
    expect(out.crops).toBe(1)
    expect((await fs.readdir(join(home, 'again.crops'))).sort(), 'only the crop the new flow names is left').toEqual(['000001.png'])
  })

  it.each([
    ['a relative path', 'flows/x.nawi.yaml', 'INVALID_ARGUMENTS'],
    ['a path without the flow suffix', '/x.yaml', 'INVALID_ARGUMENTS'],
    ['a path outside the allowed folders', join(tmpdir(), 'nawi-not-home-x.nawi.yaml'), 'INVALID_ARGUMENTS'],
    // Same answer whether a folder outside the roots exists or not: no probing the disk through the error code.
    ['a missing folder outside the allowed folders', '/nawi-missing-folder/x.nawi.yaml', 'INVALID_ARGUMENTS'],
    ['a folder inside them that does not exist', 'HOME/missing-folder/x.nawi.yaml', 'NOT_FOUND']
  ])('refuses %s before reading anything (%s)', async (_label, output, code) => {
    const abs = output.startsWith('HOME/') ? join(home, output.slice(5)) : output
    const err = await flowFromSidecar({
      revisionDir: join(rev, 'no-such-revision'),
      sidecar: recording({ input_events: { path: 'gone.ndjson', count: 1 } }),
      revision: 'v1',
      output: abs,
      roots: [home]
    }).catch((e: unknown) => e)
    expect(err, `output ${abs}: the path is checked before the (missing) events are`).toBeInstanceOf(ToolError)
    expect((err as ToolError).code, `output ${abs}`).toBe(code)
  })

  it('never writes through a link: a symlinked flow file or crops folder is refused', async () => {
    await fs.writeFile(join(home, 'target.txt'), 'keep me')
    await fs.symlink(join(home, 'target.txt'), join(home, 'linked.nawi.yaml'))
    expect(await codeOf(write(join(home, 'linked.nawi.yaml'), [clickSave], { overwrite: true })), 'symlinked flow file').toBe('INVALID_ARGUMENTS')
    await fs.mkdir(join(home, 'elsewhere'))
    await fs.symlink(join(home, 'elsewhere'), join(home, 'dirlink.crops'))
    expect(await codeOf(write(join(home, 'dirlink.nawi.yaml'), [clickSave], { overwrite: true })), 'symlinked crops folder').toBe('INVALID_ARGUMENTS')
    expect(await fs.readFile(join(home, 'target.txt'), 'utf8')).toBe('keep me')
    expect(await fs.readdir(join(home, 'elsewhere'))).toEqual([])
  })

  it('keeps a step whose crop is not a PNG, missing, or links out of the capture, without its image, and says so', async () => {
    const bad = (n: string, t: number) => ({ t_ms: t, type: 'click', target: { ...SAVE, selectors: [{ strategy: 'id', value: `#b${n}`, stability: 0.9 }], image: `input_crops/00000${n}.png` }, value_redacted: false })
    const file = join(home, 'bad-crops.nawi.yaml')
    const out = await write(file, [bad('2', 10), bad('3', 20), bad('9', 30), clickSave])
    const parsed = parseFlow(out.flow_yaml)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.flow.steps.map((s) => ('target' in s ? s.target?.image : undefined)), 'not a PNG / symlink out / missing: no image; the good one kept').toEqual([
      undefined,
      undefined,
      undefined,
      'bad-crops.crops/000001.png'
    ])
    expect(out.crops).toBe(1)
    expect(out.warnings, JSON.stringify(out.warnings)).toContain(
      "3 steps' reference crop could not be read from the capture, so those steps have no image (they still replay by their locators)."
    )
    expect(await fs.readdir(join(home, 'bad-crops.crops'))).toEqual(['000001.png'])
  })

  it('writes no crops folder when no step has a crop, and no image without an output path', async () => {
    const file = join(home, 'plain.nawi.yaml')
    const out = await write(file, [typeName])
    expect(out.crops).toBe(0)
    await expect(fs.lstat(join(home, 'plain.crops')), 'no empty crops folder').rejects.toThrow()

    const textOnly = await flowFromSidecar({ revisionDir: rev, sidecar: recording({ input_events: [clickSave] as never }), revision: 'v1', name: 'x' })
    expect(textOnly.flow_yaml, 'a YAML-only export names no crop file').not.toContain('image:')
    expect(textOnly).not.toHaveProperty('file')
  })
})

describe('flowFromSidecar output: crops stay with their own flow', () => {
  let home: string
  const revs: string[] = []
  /** A revision whose input_crops/000000.png is png(seed), and a click that names it. */
  const revision = async (seed: number): Promise<string> => {
    const rev = await fs.mkdtemp(join(tmpdir(), 'nawi-flow-export-own-'))
    revs.push(rev)
    await fs.mkdir(join(rev, 'input_crops'))
    await fs.writeFile(join(rev, 'input_crops', '000000.png'), png(seed))
    return rev
  }
  const click = [{ t_ms: 1, type: 'click', target: { ...SAVE, image: 'input_crops/000000.png' }, value_redacted: false }]
  const exportTo = (rev: string, output: string, overwrite = false) =>
    flowFromSidecar({ revisionDir: rev, sidecar: recording({ input_events: click as never }), revision: 'v1', name: 'x', output, overwrite, roots: [home] })
  /** The bytes of the crop the flow file at `file` points at. */
  const cropOf = async (file: string): Promise<Buffer> => {
    const parsed = parseFlow(await fs.readFile(file, 'utf8'))
    if (!parsed.ok) throw new Error(formatFlowErrors(parsed.errors))
    const step = parsed.flow.steps[0]
    const image = 'target' in step ? step.target?.image : undefined
    if (!image) throw new Error(`${file} names no crop`)
    return Buffer.from(await readFlowAsset(file, image))
  }

  beforeAll(async () => {
    home = await fs.mkdtemp(join(tmpdir(), 'nawi-flow-export-own-home-'))
  })
  afterAll(async () => {
    for (const d of [home, ...revs]) await fs.rm(d, { recursive: true, force: true })
  })

  it('gives flows whose names differ only in punctuation or script their own crops folders', async () => {
    const pairs: Array<[string, string]> = [['a.b', 'a-b'], ['注文', '日本']]
    for (const [i, [x, y]] of pairs.entries()) {
      const fx = join(home, `${x}.nawi.yaml`)
      const fy = join(home, `${y}.nawi.yaml`)
      await exportTo(await revision(10 + i), fx)
      await exportTo(await revision(20 + i), fy)
      expect((await cropOf(fx)).equals(Buffer.from(png(10 + i))), `${x}: its own crop, not ${y}'s`).toBe(true)
      expect((await cropOf(fy)).equals(Buffer.from(png(20 + i))), `${y}: its own crop`).toBe(true)
    }
  })

  it('lets only one of two racing exports to one path win, and the winner keeps its own crop', async () => {
    const file = join(home, 'race.nawi.yaml')
    const [ra, rb] = [await revision(31), await revision(32)]
    const results = await Promise.allSettled([exportTo(ra, file), exportTo(rb, file)])
    expect(results.map((r) => r.status).sort(), JSON.stringify(results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')))).toEqual(['fulfilled', 'rejected'])
    const winner = results[0].status === 'fulfilled' ? 31 : 32
    expect((await cropOf(file)).equals(Buffer.from(png(winner))), 'the flow on disk points at its own capture\'s crop').toBe(true)
  })

  it('on overwrite replaces the crops with the new capture\'s, keeps other files in the folder, and leaves no temporary files', async () => {
    const file = join(home, 'keep.nawi.yaml')
    await exportTo(await revision(41), file)
    await fs.writeFile(join(home, 'keep.crops', 'notes.txt'), 'mine')
    await exportTo(await revision(42), file, true)
    expect((await cropOf(file)).equals(Buffer.from(png(42))), 'the new capture\'s crop').toBe(true)
    expect((await fs.readdir(join(home, 'keep.crops'))).sort()).toEqual(['000000.png', 'notes.txt'])
    expect(await fs.readFile(join(home, 'keep.crops', 'notes.txt'), 'utf8')).toBe('mine')
    expect((await fs.readdir(home)).filter((f) => f.startsWith('.')), 'no .tmp/.new/.old left behind').toEqual([])
  })
})
