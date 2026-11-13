import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolError } from './errors'
import { MAX_RESOURCE_BYTES, RESOURCE_TEMPLATES, listRunResources, parseRunUri, readRunResource } from './resources'
import { RUN_RECORD_VERSION, type RunRecord } from '../run-record'

/** Roadmap AI12: saved runs read as `nawi://runs/...` MCP resources. */

const OLD = '20261102T103900123Z-a1b2c3'
const NEW = '20261103T080000000Z-d4e5f6'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 0xff, 0xd9])

let root: string

function record(runId: string, status: RunRecord['status']): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    run_id: runId,
    flow: { name: 'Checkout', file: '/home/u/flows/checkout.nawi.yaml', sha256: 'ab'.repeat(32) },
    status,
    started_at: '2026-11-03T08:00:00.000Z',
    duration_ms: 1200,
    totals: { passed: status === 'passed' ? 2 : 1, failed: status === 'failed' ? 1 : 0, skipped: 0, not_run: 0 },
    environment: { os: { platform: 'linux', release: '6', arch: 'x64' } },
    steps: []
  }
}

async function saveRun(runId: string, status: RunRecord['status'], files: Record<string, string | Buffer> = {}): Promise<string> {
  const dir = join(root, runId)
  await fs.mkdir(join(dir, 'steps'), { recursive: true })
  await fs.writeFile(join(dir, 'run.json'), JSON.stringify(record(runId, status)))
  for (const [name, body] of Object.entries(files)) await fs.writeFile(join(dir, name), body)
  return dir
}

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  const err = await promise.then(
    (value) => {
      throw new Error(`expected a refusal, got ${JSON.stringify(value).slice(0, 200)}`)
    },
    (e: unknown) => e
  )
  expect(err, 'the refusal should be a typed ToolError').toBeInstanceOf(ToolError)
  return err as ToolError
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'nawi-resources-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('parseRunUri', () => {
  it.each([
    [`nawi://runs/${OLD}/run.json`, 'run.json', 'application/json'],
    [`nawi://runs/${OLD}/report.html`, 'report.html', 'text/html'],
    [`nawi://runs/${OLD}/junit.xml`, 'junit.xml', 'application/xml'],
    [`nawi://runs/${OLD}/steps/003-save.after.jpg`, 'steps/003-save.after.jpg', 'image/jpeg'],
    [`nawi://runs/${OLD}/steps/001-shot.png`, 'steps/001-shot.png', 'image/png'],
    [`nawi://runs/${OLD}/network.har`, 'network.har', 'application/json']
  ])('accepts %s', (uri, file, mimeType) => {
    expect(parseRunUri(uri), uri).toEqual({ runId: OLD, file, mimeType })
  })

  it.each([
    ['another scheme', `file:///runs/${OLD}/run.json`],
    ['no file', `nawi://runs/${OLD}`],
    ['a malformed run id', 'nawi://runs/latest/run.json'],
    ['a dot-dot run id', 'nawi://runs/../run.json'],
    ['a walk out of the run folder', `nawi://runs/${OLD}/../${NEW}/run.json`],
    ['a percent-encoded dot path', `nawi://runs/${OLD}/steps/%2E%2E/run.json`],
    ['a file the writer never makes', `nawi://runs/${OLD}/steps/003-save.after.png.exe`],
    ['a query string', `nawi://runs/${OLD}/run.json?x=1`],
    ['an inherited key', `nawi://runs/${OLD}/constructor`],
    ['a HAR anywhere but the run folder', `nawi://runs/${OLD}/steps/network.har`],
    ['a HAR by another name', `nawi://runs/${OLD}/network.har.json`]
  ])('refuses %s', (_label, uri) => {
    expect(parseRunUri(uri), uri).toBeNull()
  })
})

describe('resource templates', () => {
  it('has one template per kind of file a run folder holds, all under nawi://runs/{run_id}/', () => {
    expect(RESOURCE_TEMPLATES.map((t) => t.uriTemplate)).toEqual([
      'nawi://runs/{run_id}/run.json',
      'nawi://runs/{run_id}/report.html',
      'nawi://runs/{run_id}/junit.xml',
      'nawi://runs/{run_id}/network.har',
      'nawi://runs/{run_id}/{+screenshot}'
    ])
  })
})

describe('listRunResources', () => {
  it('names the record of each run, newest first, and the report only where the run has one', async () => {
    await saveRun(OLD, 'passed', { 'report.html': '<html></html>' })
    await saveRun(NEW, 'failed')
    const listed = await listRunResources(root)
    expect(listed.map((r) => r.uri)).toEqual([
      `nawi://runs/${NEW}/run.json`,
      `nawi://runs/${OLD}/run.json`,
      `nawi://runs/${OLD}/report.html`
    ])
    expect(listed[0], 'the newest (failed) run').toMatchObject({ title: 'Run Checkout: failed', mimeType: 'application/json' })
    expect(listed[2], 'the report carries its size').toMatchObject({ mimeType: 'text/html', size: 13 })
  })

  it('skips folders that are not a whole run record and caps the number of runs', async () => {
    await saveRun(OLD, 'passed')
    await saveRun(NEW, 'passed')
    await fs.mkdir(join(root, '20261104T080000000Z-000000'))
    expect((await listRunResources(root, 1)).map((r) => r.uri)).toEqual([`nawi://runs/${NEW}/run.json`])
  })

  it('lists nothing when there is no runs folder yet', async () => {
    expect(await listRunResources(join(root, 'missing'))).toEqual([])
  })
})

describe('readRunResource', () => {
  it('returns run.json as text, byte for byte', async () => {
    await saveRun(OLD, 'passed')
    const got = await readRunResource(root, `nawi://runs/${OLD}/run.json`)
    expect(got).toEqual({
      uri: `nawi://runs/${OLD}/run.json`,
      mimeType: 'application/json',
      text: await fs.readFile(join(root, OLD, 'run.json'), 'utf8')
    })
  })

  it('returns a screenshot as base64 that decodes to the saved bytes', async () => {
    await saveRun(OLD, 'failed', { 'steps/002-pay.after.jpg': JPEG })
    const got = await readRunResource(root, `nawi://runs/${OLD}/steps/002-pay.after.jpg`)
    expect(got.mimeType).toBe('image/jpeg')
    expect('blob' in got && Buffer.from(got.blob, 'base64').equals(JPEG), 'blob should decode to the JPEG on disk').toBe(true)
  })

  it("returns a browser run's network.har as JSON text", async () => {
    const har = JSON.stringify({ log: { version: '1.2', entries: [{ _step_id: 'pay' }] } })
    await saveRun(OLD, 'failed', { 'network.har': har })
    const got = await readRunResource(root, `nawi://runs/${OLD}/network.har`)
    expect(got, 'a HAR is text, not a blob').toEqual({ uri: `nawi://runs/${OLD}/network.har`, mimeType: 'application/json', text: har })
  })

  it('refuses a non-string or malformed uri as INVALID_ARGUMENTS, naming the uri', async () => {
    expect((await refusal(readRunResource(root, 42))).code).toBe('INVALID_ARGUMENTS')
    const bad = await refusal(readRunResource(root, `nawi://runs/${OLD}/../x`))
    expect(bad.code).toBe('INVALID_ARGUMENTS')
    expect(bad.detail).toEqual({ uri: `nawi://runs/${OLD}/../x` })
  })

  it('answers NOT_FOUND for a run that does not exist, a file the run lacks, and a folder that is not a whole record', async () => {
    await saveRun(OLD, 'passed')
    await fs.mkdir(join(root, NEW, 'steps'), { recursive: true })
    await fs.writeFile(join(root, NEW, 'junit.xml'), '<testsuite/>')
    for (const uri of [
      `nawi://runs/20261101T000000000Z-000000/run.json`,
      `nawi://runs/${OLD}/report.html`,
      `nawi://runs/${NEW}/junit.xml`
    ]) {
      const err = await refusal(readRunResource(root, uri))
      expect(err.code, uri).toBe('NOT_FOUND')
      expect(err.detail, uri).toEqual({ uri })
    }
  })

  it.skipIf(process.platform === 'win32')('will not follow a symlink planted in a run folder', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'nawi-outside-'))
    try {
      await fs.writeFile(join(outside, '001-a.after.jpg'), 'not yours')
      const dir = await saveRun(OLD, 'passed')
      const uri = `nawi://runs/${OLD}/steps/001-a.after.jpg`
      // A screenshot that is a link to a file outside the runs folder.
      await fs.symlink(join(outside, '001-a.after.jpg'), join(dir, 'steps/001-a.after.jpg'))
      expect((await refusal(readRunResource(root, uri))).code, 'file symlink').toBe('NOT_FOUND')
      // The whole steps folder is a link to a folder outside.
      await fs.rm(join(dir, 'steps'), { recursive: true })
      await fs.symlink(outside, join(dir, 'steps'))
      expect((await refusal(readRunResource(root, uri))).code, 'folder symlink').toBe('NOT_FOUND')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('will not serve another run\'s files through a linked run or steps folder', async () => {
    const other = await saveRun(NEW, 'passed', { 'steps/001-a.after.jpg': JPEG })
    // A run folder that is a link to another run.
    await fs.symlink(other, join(root, OLD))
    expect((await refusal(readRunResource(root, `nawi://runs/${OLD}/steps/001-a.after.jpg`))).code, 'linked run folder').toBe('NOT_FOUND')
    await fs.rm(join(root, OLD))
    // A real run whose steps folder links to another run's.
    const dir = await saveRun(OLD, 'passed')
    await fs.rm(join(dir, 'steps'), { recursive: true })
    await fs.symlink(join(other, 'steps'), join(dir, 'steps'))
    expect((await refusal(readRunResource(root, `nawi://runs/${OLD}/steps/001-a.after.jpg`))).code, 'linked steps folder').toBe('NOT_FOUND')
  })

  it('refuses a file larger than one message carries as UNAVAILABLE with its size and the limit, and does not list such a report', async () => {
    const dir = await saveRun(OLD, 'passed')
    const big = join(dir, 'steps/001-a.png')
    await fs.writeFile(big, '')
    await fs.truncate(big, MAX_RESOURCE_BYTES + 1)
    const err = await refusal(readRunResource(root, `nawi://runs/${OLD}/steps/001-a.png`))
    expect(err.code).toBe('UNAVAILABLE')
    expect(err.detail).toMatchObject({ size: MAX_RESOURCE_BYTES + 1, limit: MAX_RESOURCE_BYTES })

    await fs.writeFile(join(dir, 'report.html'), '')
    await fs.truncate(join(dir, 'report.html'), MAX_RESOURCE_BYTES + 1)
    expect((await listRunResources(root)).map((r) => r.uri), 'an unreadable report is not offered').toEqual([`nawi://runs/${OLD}/run.json`])
  })
})
