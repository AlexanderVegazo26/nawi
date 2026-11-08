import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowSchema } from '@shared/flow'
import {
  MAX_FLOW_FILE_BYTES,
  REPORTED_EVIDENCE_PER_STEP,
  defaultOpenPage,
  readFlowAsset,
  resolveFlowFile,
  runFlowFile,
  trimEvidence,
  withVars,
  type BrowserPage,
  type OpenPage
} from './flow-run'
import { ToolError } from './mcp/errors'
import { MAX_ANCHOR_BYTES } from './replay/replay'
import type { StepEvidence } from './replay/evidence'

/** The typed code a call failed with, or 'resolved'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'resolved'
  } catch (err) {
    return err instanceof ToolError ? err.code : `untyped: ${String(err)}`
  }
}

const FLOW = `version: 1
name: Demo
target: { kind: browser, url: "https://example.test/" }
vars: { who: "a@b.example" }
steps:
  - { id: s1, action: fill, target: { selectors: [{ id: email }] }, value: "\${vars.who}" }
`

let root: string
let outside: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nawi-flowrun-root-'))
  outside = mkdtempSync(join(tmpdir(), 'nawi-flowrun-out-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('readFlowAsset: reference crops are read only from the flow\'s own folder', () => {
  const flowIn = (dir: string): string => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'a.nawi.yaml')
    writeFileSync(file, FLOW)
    return file
  }

  it('reads a file next to the flow or in a subfolder of it', async () => {
    const file = flowIn(join(root, 'flows'))
    mkdirSync(join(root, 'flows', 'crops'))
    writeFileSync(join(root, 'flows', 'crops', 'save.png'), 'png-bytes')
    expect(Buffer.from(await readFlowAsset(file, 'crops/save.png')).toString()).toBe('png-bytes')
  })

  it('refuses a missing file, a folder, a file over the size limit, and a path that climbs out', async () => {
    const file = flowIn(join(root, 'flows'))
    mkdirSync(join(root, 'flows', 'dir.png'))
    writeFileSync(join(root, 'flows', 'big.png'), Buffer.alloc(MAX_ANCHOR_BYTES + 1))
    writeFileSync(join(root, 'secret.txt'), 'token=abc')
    await expect(readFlowAsset(file, 'nope.png')).rejects.toThrow(/nope\.png does not exist next to the flow/)
    await expect(readFlowAsset(file, 'dir.png')).rejects.toThrow(/dir\.png is not a file/)
    await expect(readFlowAsset(file, 'big.png')).rejects.toThrow(/big\.png is larger than/)
    await expect(readFlowAsset(file, '../secret.txt'), 'the schema refuses "..", the reader too').rejects.toThrow(/outside the flow's folder/)
  })

  it.skipIf(process.platform === 'win32')('refuses a named pipe without blocking on it', async () => {
    const file = flowIn(join(root, 'flows'))
    execFileSync('mkfifo', [join(root, 'flows', 'pipe.png')])
    await expect(readFlowAsset(file, 'pipe.png')).rejects.toThrow(/pipe\.png is not a file/)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink in the flow\'s folder that points outside it', async () => {
    const file = flowIn(join(root, 'flows'))
    writeFileSync(join(outside, 'secret.png'), 'token=abc')
    symlinkSync(join(outside, 'secret.png'), join(root, 'flows', 'leak.png'))
    await expect(readFlowAsset(file, 'leak.png')).rejects.toThrow(/leak\.png resolves outside the flow's folder/)
  })
})

describe('resolveFlowFile: which files a run may read', () => {
  it('accepts an absolute *.nawi.yaml file inside an allowed root and returns its real path', async () => {
    mkdirSync(join(root, 'flows'))
    const file = join(root, 'flows', 'a.nawi.yaml')
    writeFileSync(file, FLOW)
    await expect(resolveFlowFile(file, [root])).resolves.toMatch(/flows[\\/]a\.nawi\.yaml$/)
  })

  it.each([
    ['a relative path', () => 'flows/a.nawi.yaml', 'INVALID_ARGUMENTS'],
    ['another extension', () => join(root, 'id_ed25519'), 'INVALID_ARGUMENTS'],
    ['a missing file', () => join(root, 'nope.nawi.yaml'), 'NOT_FOUND'],
    ['a flow file outside the roots', () => (writeFileSync(join(outside, 'x.nawi.yaml'), FLOW), join(outside, 'x.nawi.yaml')), 'INVALID_ARGUMENTS'],
    ['a directory named like a flow', () => (mkdirSync(join(root, 'd.nawi.yaml')), join(root, 'd.nawi.yaml')), 'INVALID_ARGUMENTS'],
    ['a dot-dot escape', () => (writeFileSync(join(outside, 'y.nawi.yaml'), FLOW), join(root, '..', outside.split(/[\\/]/).pop()!, 'y.nawi.yaml')), 'INVALID_ARGUMENTS']
  ])('refuses %s', async (_label, make, code) => {
    const file = make()
    expect(await codeOf(resolveFlowFile(file, [root])), `file ${file}`).toBe(code)
  })

  it.skipIf(process.platform === 'win32')('refuses a *.nawi.yaml symlink to a non-flow file or to a flow outside the roots', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'token=abc')
    writeFileSync(join(outside, 'z.nawi.yaml'), FLOW)
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.nawi.yaml'))
    symlinkSync(join(outside, 'z.nawi.yaml'), join(root, 'out.nawi.yaml'))
    expect(await codeOf(resolveFlowFile(join(root, 'leak.nawi.yaml'), [root])), 'symlink to secret.txt').toBe('INVALID_ARGUMENTS')
    expect(await codeOf(resolveFlowFile(join(root, 'out.nawi.yaml'), [root])), 'symlink out of root').toBe('INVALID_ARGUMENTS')
  })

  it('gives a path outside the roots the same refusal whether or not anything is there (no existence oracle)', async () => {
    writeFileSync(join(outside, 'real.nawi.yaml'), FLOW)
    const answers = await Promise.all(
      [join(outside, 'real.nawi.yaml'), join(outside, 'missing.nawi.yaml'), join(outside, 'no-such-dir', 'x.nawi.yaml')].map(async (file) => {
        const err = await resolveFlowFile(file, [root]).catch((e: unknown) => e)
        return err instanceof ToolError ? `${err.code}: ${err.message}` : `not a ToolError: ${String(err)}`
      })
    )
    expect(new Set(answers).size, `answers for existing / missing file / missing folder outside the root: ${JSON.stringify(answers)}`).toBe(1)
    expect(answers[0]).toMatch(/^INVALID_ARGUMENTS: Flow files must live inside/)
  })

  it('refuses a file over the size limit before reading it', async () => {
    const file = join(root, 'big.nawi.yaml')
    writeFileSync(file, `# ${'x'.repeat(MAX_FLOW_FILE_BYTES)}\n`)
    expect(await codeOf(resolveFlowFile(file, [root]))).toBe('INVALID_ARGUMENTS')
  })
})

describe("trimEvidence: run_flow's answer stays small on a noisy page", () => {
  it(`keeps the first ${REPORTED_EVIDENCE_PER_STEP} of each kind and adds the rest to the dropped counts`, () => {
    const errors = Array.from({ length: 20 }, (_, i) => ({ source: 'console' as const, message: `e${i}` }))
    const requests = Array.from({ length: 5 }, (_, i) => ({ method: 'GET', url: `https://a.example/${i}`, status: 500 }))
    const input: StepEvidence = { consoleErrors: errors, consoleErrorsDropped: 7, failedRequests: requests, url: 'https://a.example/' }
    const out = trimEvidence(input)
    expect(out.consoleErrors?.map((c) => c.message)).toEqual(['e0', 'e1', 'e2'])
    expect(out.consoleErrorsDropped, '17 trimmed + 7 the record already dropped').toBe(24)
    expect(out.failedRequests).toHaveLength(3)
    expect(out.failedRequestsDropped).toBe(2)
    expect(out.url).toBe('https://a.example/')
    const small = { consoleErrors: errors.slice(0, 2) }
    expect(trimEvidence(small), 'under the limit: unchanged').toEqual(small)
  })
})

describe('withVars', () => {
  const flow = FlowSchema.parse({
    version: 1,
    name: 'v',
    target: { kind: 'browser', url: 'https://example.test/' },
    vars: { who: 'x' },
    steps: [{ id: 's', action: 'fill', target: { selectors: [{ id: 'e' }] }, value: '${vars.who}' }]
  })

  it('overrides a declared var', () => {
    expect(withVars(flow, { who: 'y' }).vars).toEqual({ who: 'y' })
    expect(flow.vars, 'the parsed flow is not mutated').toEqual({ who: 'x' })
  })

  it('refuses an undeclared var and names the declared ones', () => {
    expect(() => withVars(flow, { whom: 'y' })).toThrow(/does not declare "whom" under vars \(declared: who\)/)
  })

  it('refuses a value that references another var', () => {
    expect(() => withVars(flow, { who: '${vars.who}' })).toThrow(/A var value is not valid/)
  })
})

describe('runFlowFile with a fake browser', () => {
  const fakePage = (log: string[], send: BrowserPage['client']['send']): OpenPage =>
    async ({ headless }) => {
      log.push(`open headless=${headless}`)
      return { client: { send }, sessionId: 'S', close: async () => void log.push('close') }
    }

  it('closes the page after a run whose browser answers nothing useful, and reports failure, not a throw', async () => {
    const file = join(root, 'f.nawi.yaml')
    writeFileSync(file, FLOW)
    const log: string[] = []
    const report = await runFlowFile(
      { file, headless: true },
      { roots: [root], openPage: fakePage(log, async () => { throw new Error('Target closed') }) }
    )
    expect(report.status).toBe('failed')
    expect(report.error).toMatch(/could not open the flow's target/)
    expect(report.steps).toEqual([{ id: 's1', action: 'fill', status: 'not_run' }])
    expect(log).toEqual(['open headless=true', 'close'])
  })

  it('saves a run record with the browser version and viewport when the app passes a record folder', async () => {
    const file = join(root, 'f.nawi.yaml')
    writeFileSync(file, FLOW)
    const runs = join(root, 'runs')
    const send = (async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Browser.getVersion') return { product: 'Chrome/150.0.1.2', protocolVersion: '1.3' }
      if (method === 'Runtime.evaluate' && String(params?.expression).includes('innerWidth')) return { result: { value: [1280, 800, 2] } }
      throw new Error('Target closed')
    }) as BrowserPage['client']['send']
    const report = await runFlowFile(
      { file },
      { roots: [root], openPage: fakePage([], send), now: () => Date.UTC(2026, 10, 2), record: { dir: runs, appVersion: '9.9.9' } }
    )
    expect(report.run_id, JSON.stringify(report)).toMatch(/^20261102T000000000Z-[0-9a-f]{6}$/)
    const record = JSON.parse(readFileSync(join(report.run_dir!, 'run.json'), 'utf8'))
    expect(record.environment).toMatchObject({
      app_version: '9.9.9',
      browser: { product: 'Chrome/150.0.1.2', protocol_version: '1.3' },
      viewport: { width: 1280, height: 800, device_scale_factor: 2 }
    })
    expect(record.flow.file).toBe(file)
    expect(record.flow.sha256, 'hash of the exact file that ran').toBe(
      (await import('node:crypto')).createHash('sha256').update(FLOW).digest('hex')
    )
    expect(record).toMatchObject({ status: 'failed', steps: [{ id: 's1', status: 'not_run' }] })
  })

  it('records a run that failed before a browser was opened, without browser facts', async () => {
    const file = join(root, 'needs.nawi.yaml')
    writeFileSync(file, FLOW.replace('"a@b.example"', '"${env.TEST_EMAIL}"'))
    const runs = join(root, 'runs')
    const log: string[] = []
    const report = await runFlowFile({ file }, { roots: [root], openPage: fakePage(log, async () => ({}) as never), record: { dir: runs } })
    expect(log, 'no browser was opened').toEqual([])
    const record = JSON.parse(readFileSync(join(report.run_dir!, 'run.json'), 'utf8'))
    expect(record.error).toMatch(/TEST_EMAIL/)
    expect(record.environment.browser, 'no browser ran').toBeUndefined()
    expect(readFileSync(join(report.run_dir!, 'junit.xml'), 'utf8')).toContain('errors="1"')
  })

  it('still answers with the run result when the record cannot be saved, and says why', async () => {
    const file = join(root, 'f.nawi.yaml')
    writeFileSync(file, FLOW)
    const notAFolder = join(root, 'runs-file')
    writeFileSync(notAFolder, 'x')
    const report = await runFlowFile(
      { file },
      { roots: [root], openPage: fakePage([], async () => { throw new Error('Target closed') }), record: { dir: notAFolder } }
    )
    expect(report.status).toBe('failed')
    expect(report.run_dir).toBeUndefined()
    expect(report.record_error, JSON.stringify(report)).toMatch(/EEXIST|ENOTDIR/)
  })

  it('hashes the raw bytes of the flow file, even when they are not valid UTF-8', async () => {
    const file = join(root, 'latin1.nawi.yaml')
    const bytes = Buffer.concat([Buffer.from(`${FLOW}# caf`), Buffer.from([0xe9, 0x0a])]) // a Latin-1 é in a comment
    writeFileSync(file, bytes)
    const report = await runFlowFile({ file }, { roots: [root], openPage: fakePage([], async () => { throw new Error('Target closed') }), record: { dir: join(root, 'runs') } })
    const record = JSON.parse(readFileSync(join(report.run_dir!, 'run.json'), 'utf8'))
    expect(record.flow.sha256).toBe((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'))
  })

  it('reports a record that cannot be named (bad clock) as record_error instead of throwing the run away', async () => {
    const file = join(root, 'f.nawi.yaml')
    writeFileSync(file, FLOW)
    const report = await runFlowFile(
      { file },
      { roots: [root], openPage: fakePage([], async () => { throw new Error('Target closed') }), now: () => NaN, record: { dir: join(root, 'runs') } }
    )
    expect(report.status).toBe('failed')
    expect(report.record_error, JSON.stringify(report)).toMatch(/Invalid time value/)
  })

  it('prunes old runs down to the keep limit after saving', async () => {
    const file = join(root, 'f.nawi.yaml')
    writeFileSync(file, FLOW)
    const runs = join(root, 'runs')
    let t = Date.UTC(2026, 10, 2)
    const deps = { roots: [root], openPage: fakePage([], async () => { throw new Error('Target closed') }), now: () => (t += 1000), record: { dir: runs, keep: 2 } }
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await runFlowFile({ file }, deps)).run_id!)
    expect(readdirSync(runs).sort()).toEqual(ids.slice(1))
  })

  it('does not open a browser for an invalid flow file, a desktop or an android target', async () => {
    const bad = join(root, 'bad.nawi.yaml')
    writeFileSync(bad, 'version: 1\nname: x\n')
    const desktop = join(root, 'desk.nawi.yaml')
    writeFileSync(desktop, 'version: 1\nname: d\ntarget: { kind: desktop, app: Notes }\nsteps:\n  - { id: s1, action: press, key: Enter }\n')
    const log: string[] = []
    const openPage = fakePage(log, async () => ({}) as never)
    expect(await codeOf(runFlowFile({ file: bad }, { roots: [root], openPage })), 'invalid flow').toBe('INVALID_ARGUMENTS')
    expect(await codeOf(runFlowFile({ file: desktop }, { roots: [root], openPage })), 'desktop flow').toBe('NOT_IMPLEMENTED')
    const android = join(root, 'phone.nawi.yaml')
    writeFileSync(android, 'version: 1\nname: a\ntarget: { kind: android, package: dev.nawi.shop }\nsteps:\n  - { id: s1, action: press, key: Back }\n')
    const noDevices = { env: {}, platform: 'linux' as const, arch: 'x64', home: root, kvmPath: join(root, 'kvm'), exec: async () => ({ code: null, stdout: '', stderr: '', error: 'not_found' as const }), delay: async () => undefined, now: Date.now }
    expect(await codeOf(runFlowFile({ file: android }, { roots: [root], openPage, androidHost: noDevices })), 'android flow without adb: no device, no browser').toBe('UNAVAILABLE')
    expect(await codeOf(runFlowFile({ file: join(root, 'f2.nawi.yaml') }, { roots: [root], openPage }))).toBe('NOT_FOUND')
    expect(log, 'no browser was opened').toEqual([])
  })

  it('fails a run with missing env/secret inputs before opening a browser, naming each one', async () => {
    const file = join(root, 'needs.nawi.yaml')
    writeFileSync(
      file,
      FLOW.replace('"a@b.example"', '"${env.TEST_EMAIL}"') + '  - { id: s2, action: fill, target: { selectors: [{ id: pw }] }, value: "${secret.pw}" }\n'
    )
    const log: string[] = []
    const report = await runFlowFile({ file, env: {}, secrets: {} }, { roots: [root], openPage: fakePage(log, async () => ({}) as never) })
    expect(report.status).toBe('failed')
    expect(report.error).toBe('the flow needs values the run did not provide: ${env.TEST_EMAIL}, ${secret.pw}')
    expect(report.steps.map((s) => s.status)).toEqual(['not_run', 'not_run'])
    expect(log, 'no browser was opened').toEqual([])
  })

  it('does not resolve ${env.constructor} or ${secret.toString} from Object.prototype', async () => {
    const file = join(root, 'proto.nawi.yaml')
    writeFileSync(file, FLOW.replace('"a@b.example"', '"${env.constructor}${secret.toString}"'))
    const report = await runFlowFile({ file }, { roots: [root], openPage: fakePage([], async () => ({}) as never) })
    expect(report.error).toBe('the flow needs values the run did not provide: ${env.constructor}, ${secret.toString}')
  })

  it('does not open a browser when the run was stopped before it started', async () => {
    const file = join(root, 'f.nawi.yaml')
    writeFileSync(file, FLOW)
    const log: string[] = []
    const stop = new AbortController()
    stop.abort('agent access was paused')
    const report = await runFlowFile({ file }, { roots: [root], signal: stop.signal, openPage: fakePage(log, async () => ({}) as never) })
    expect(report).toMatchObject({ status: 'failed', error: 'agent access was paused', steps: [{ id: 's1', status: 'not_run' }] })
    expect(log, 'no browser was opened').toEqual([])
  })

  it('accepts a folder inside the root whose name starts with two dots', async () => {
    mkdirSync(join(root, '..flows'))
    const file = join(root, '..flows', 'a.nawi.yaml')
    writeFileSync(file, FLOW)
    await expect(resolveFlowFile(file, [root])).resolves.toMatch(/\.\.flows[\\/]a\.nawi\.yaml$/)
  })

  it('turns a browser that cannot start into UNAVAILABLE with the reason', async () => {
    const file = join(root, 'f.nawi.yaml')
    writeFileSync(file, FLOW)
    const err = await runFlowFile({ file }, { roots: [root], openPage: async () => { throw new Error('no Chrome found') } }).catch((e) => e)
    expect(err).toBeInstanceOf(ToolError)
    expect((err as ToolError).code).toBe('UNAVAILABLE')
    expect((err as ToolError).message).toContain('no Chrome found')
  })

  it('refuses a local endpoint whose /json/version points the socket at another host', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(req.url?.startsWith('/json/version') ? JSON.stringify({ webSocketDebuggerUrl: 'ws://10.0.0.5:9222/devtools/browser/x' }) : '[]')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const port = (server.address() as { port: number }).port
      const err = await defaultOpenPage()({ headless: true, cdpEndpoint: `127.0.0.1:${port}` }).catch((e) => e)
      expect(err, String(err)).toBeInstanceOf(ToolError)
      expect((err as ToolError).code).toBe('INVALID_ARGUMENTS')
      expect((err as ToolError).message).toContain('pointed at 10.0.0.5')
    } finally {
      server.close()
    }
  })

  it.each(['10.0.0.5:9222', 'http://example.com:9222', 'evil.localhost.example:9222', 'not a host'])(
    'refuses to attach to a non-loopback DevTools endpoint %s without connecting',
    async (endpoint) => {
      expect(await codeOf(defaultOpenPage()({ headless: true, cdpEndpoint: endpoint }))).toBe('INVALID_ARGUMENTS')
    }
  )
})
