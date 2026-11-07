import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyExecError, runBytes, runText } from './exec'

// Real child processes (this Node binary running a one-line script), so these pin what node's execFile actually
// reports, not what a fake assumes. A fake that got it wrong is how a dump over 1 MB came to be shown as cut off.
const node = process.execPath
const script = (code: string): string[] => ['-e', code]
const CAP = 64 * 1024
const empty = mkdtempSync(join(tmpdir(), 'nawi-exec-'))
afterAll(() => rmSync(empty, { recursive: true, force: true }))

describe('runText', () => {
  it('returns exit code 0 and both streams for a process that succeeds', async () => {
    const r = await runText(node, script('process.stdout.write("out"); process.stderr.write("err")'), 10_000, CAP)
    expect(r, 'a clean exit has no error kind').toEqual({ code: 0, stdout: 'out', stderr: 'err' })
  })

  it('reports too_large, not a timeout or a plain failure, when stdout passes the cap', async () => {
    const r = await runText(node, script(`process.stdout.write("x".repeat(${CAP * 3}))`), 10_000, CAP)
    expect({ error: r.error, code: r.code }, 'stdout 3x the cap').toEqual({ error: 'too_large', code: null })
    expect(r.stdout.length, 'node keeps the output up to the cap').toBe(CAP)
  })

  it('reports too_large when stderr passes the cap', async () => {
    const r = await runText(node, script(`process.stderr.write("e".repeat(${CAP * 3}))`), 10_000, CAP)
    expect(r.error, 'stderr 3x the cap').toBe('too_large')
  })

  it('reports timeout for a process still running at the deadline', async () => {
    const r = await runText(node, script('setTimeout(() => {}, 30_000)'), 300, CAP)
    expect({ error: r.error, code: r.code }, 'a 30 s sleeper with a 300 ms deadline').toEqual({ error: 'timeout', code: null })
  })

  it('reports failed with the exit code and keeps the output of a non-zero exit', async () => {
    const r = await runText(node, script('process.stdout.write("partial"); process.stderr.write("why"); process.exit(3)'), 10_000, CAP)
    expect(r, 'exit 3').toEqual({ code: 3, stdout: 'partial', stderr: 'why', error: 'failed' })
  })

  it('reports not_found for a binary that does not exist', async () => {
    const r = await runText(join(empty, 'no-such-adb'), [], 10_000, CAP)
    expect({ error: r.error, code: r.code }, `spawning ${join(empty, 'no-such-adb')}`).toEqual({ error: 'not_found', code: null })
  })

  it('accepts a fractional timeout (deadlines computed from performance.now())', async () => {
    const r = await runText(node, script('process.stdout.write("ok")'), 9_999.998, CAP)
    expect(r, 'execFile throws on a non-integer timeout unless it is rounded').toEqual({ code: 0, stdout: 'ok', stderr: '' })
  })
})

describe('runBytes', () => {
  it('returns stdout as bytes, unchanged', async () => {
    const r = await runBytes(node, script('process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))'), 10_000, CAP)
    expect(r.error, 'a clean exit').toBeUndefined()
    expect(Array.from(r.stdout), 'PNG-like bytes incl. 0x00 and 0xff').toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
  })

  it('reports too_large when the output passes the cap', async () => {
    const r = await runBytes(node, script(`process.stdout.write(Buffer.alloc(${CAP * 3}))`), 10_000, CAP)
    expect({ error: r.error, code: r.code }, 'stdout 3x the cap').toEqual({ error: 'too_large', code: null })
  })

  it('reports timeout for a process still running at the deadline', async () => {
    const r = await runBytes(node, script('setTimeout(() => {}, 30_000)'), 300, CAP)
    expect(r.error, 'a 30 s sleeper with a 300 ms deadline').toBe('timeout')
  })
})

describe('classifyExecError', () => {
  it.each([
    ['a missing binary', { code: 'ENOENT' }, { code: null, error: 'not_found' }],
    ['a binary without execute permission', { code: 'EACCES' }, { code: null, error: 'not_found' }],
    ['output past maxBuffer', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, { code: null, error: 'too_large' }],
    ['the timeout kill', { code: null, killed: true, signal: 'SIGTERM' }, { code: null, error: 'timeout' }],
    ['a non-zero exit', { code: 2, killed: false, signal: null }, { code: 2, error: 'failed' }],
    ['death by another signal', { code: null, killed: false, signal: 'SIGSEGV' }, { code: null, error: 'failed' }]
  ])('maps %s', (_what, err, expected) => {
    expect(classifyExecError(Object.assign(new Error('x'), err) as never), JSON.stringify(err)).toEqual(expected)
  })
})
