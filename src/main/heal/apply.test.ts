import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFlow } from '../../shared/flow/yaml'
import type { FlowRunReport } from '../flow-run'
import type { RecordedStep, RunRecord } from '../run-record'
import { applyHeal, judgeReplay, type ApplyHealDeps } from './apply'

/**
 * apply_heal's decisions with a scripted replay and a real flow file in a temp
 * folder: when it writes, what it writes, and every reason it leaves the file alone.
 */

const FLOW = `version: 1
name: Save a note
target: { kind: browser, url: "https://app.example/notes" }
steps:
  - id: open
    action: click
    target:
      selectors:
        - { testid: open-editor } # renamed in 2.0
        - { css: "#open" }
  - id: save
    intent: Save the note
    action: click
    target:
      selectors:
        - { role: button, name: Save }
        - { css: "#save" }
  - id: done
    action: assert
    target: { selectors: [{ role: status }] }
    expect: { text: Saved }
`

const HEALED_BOTH = FLOW.replace('        - { testid: open-editor } # renamed in 2.0\n', '').replace('        - { role: button, name: Save }\n', '')
const HEALED_SAVE = FLOW.replace('        - { role: button, name: Save }\n', '')

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const fallback = (id: string, css: string, missed: RecordedStep['misses']): RecordedStep => ({
  id,
  action: 'click',
  status: 'passed',
  matched: { index: 1, selector: { css }, layer: 'css', fallback: true },
  misses: missed
})
const openDrifted = fallback('open', '#open', [{ index: 0, selector: { testid: 'open-editor' }, found: 0 }])
const saveDrifted = fallback('save', '#save', [{ index: 0, selector: { role: 'button', name: 'Save' }, found: 0 }])
const doneStep: RecordedStep = { id: 'done', action: 'assert', status: 'passed', matched: { index: 0, selector: { role: 'status' }, layer: 'role', fallback: false } }

function record(steps: RecordedStep[], flowText = FLOW): RunRecord {
  return {
    version: 1,
    run_id: '20261107T130000000Z-abc123',
    flow: { name: 'Save a note', file: '/unused', sha256: sha(flowText) },
    status: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
    started_at: '2026-11-07T13:00:00.000Z',
    duration_ms: 900,
    totals: { passed: 0, failed: 0, skipped: 0, not_run: 0 },
    environment: { os: { platform: 'linux', release: '6', arch: 'x64' } },
    steps
  }
}

type ReplayStep = FlowRunReport['steps'][number]
const at0 = (id: string, layer = 'css'): ReplayStep => ({ id, action: 'click', status: 'passed', matched: { index: 0, selector: { css: 'x' }, layer: layer as never, fallback: false } })
const replayed = (steps: ReplayStep[], extra: Partial<FlowRunReport> = {}): FlowRunReport => ({
  file: '/unused',
  flow: 'Save a note',
  status: steps.every((s) => s.status === 'passed' || s.status === 'skipped') ? 'passed' : 'failed',
  duration_ms: 10,
  steps,
  ...extra
})

describe('applyHeal', () => {
  let dir: string
  let file: string
  /** What the scripted replay was given, as text. */
  let replays: string[]

  const deps = (answer: (source: string) => FlowRunReport | Promise<FlowRunReport>): ApplyHealDeps => ({
    readFlow: async () => {
      try {
        return readFileSync(file)
      } catch {
        return null
      }
    },
    realPath: async () => file,
    replay: async (source) => {
      replays.push(source.toString('utf8'))
      return answer(source.toString('utf8'))
    }
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nawi-apply-heal-'))
    file = join(dir, 'notes.nawi.yaml')
    writeFileSync(file, FLOW)
    replays = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes every proposal once the replay of the proposed flow passes with each healed step on its first locator', async () => {
    chmodSync(file, 0o640)
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), undefined, deps(() => replayed([at0('open'), at0('save'), at0('done', 'role')])))
    expect(result, JSON.stringify(result, null, 1)).toMatchObject({ applied: true, flow_status: 'current', step_ids: ['open', 'save'] })
    expect(replays, 'the replay ran the proposed text, not the file').toEqual([HEALED_BOTH])
    expect(readFileSync(file, 'utf8'), 'the file now holds exactly the proposal').toBe(HEALED_BOTH)
    expect(parseFlow(readFileSync(file, 'utf8')).ok).toBe(true)
    expect(statSync(file).mode & 0o777, 'the file keeps its mode').toBe(0o640)
    expect(readdirSync(dir), 'no temp file left behind').toEqual(['notes.nawi.yaml'])
    expect(result.diff).toContain('-        - { role: button, name: Save }')
    expect(result.replay?.steps.map((s) => s.matched?.index)).toEqual([0, 0, 0])
  })

  it('applies only the steps asked for', async () => {
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), ['save'], deps(() => replayed([{ ...at0('open'), matched: { index: 1, selector: { css: '#open' }, layer: 'css', fallback: true } }, at0('save'), at0('done', 'role')])))
    expect(result, JSON.stringify(result, null, 1)).toMatchObject({ applied: true, step_ids: ['save'] })
    expect(readFileSync(file, 'utf8'), 'open keeps its drifting list: it was not asked for').toBe(HEALED_SAVE)
    expect(result.diff).not.toContain('open-editor')
  })

  it('rejects a wrong match: the proposed flow fails at a later step, and the file is left alone', async () => {
    const result = await applyHeal(
      record([openDrifted, saveDrifted, doneStep]),
      undefined,
      deps(() => replayed([at0('open'), at0('save'), { id: 'done', action: 'assert', status: 'failed', error: 'expected text "Saved", got ""' }], { failed_step_id: 'done' }))
    )
    expect(result.applied).toBe(false)
    expect(result.reason).toMatch(/failed at step done when replayed \(expected text "Saved", got ""\)/)
    expect(result.reason).toMatch(/Nothing was written/)
    expect(result.replay?.status).toBe('failed')
    expect(readFileSync(file, 'utf8'), 'unchanged').toBe(FLOW)
    expect(result.diff, 'the rejected patch is still shown').toContain('-        - { role: button, name: Save }')
  })

  it('rejects when a healed step still needed a fallback in the replay', async () => {
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), ['save'], deps(() => replayed([at0('open'), { ...at0('save'), matched: { index: 1, selector: { css: 'y' }, layer: 'css', fallback: true } }, at0('done', 'role')])))
    expect(result).toMatchObject({ applied: false })
    expect(result.reason).toMatch(/Healed step save matched through locator 2 \(css, fallback\)/)
    expect(readFileSync(file, 'utf8')).toBe(FLOW)
  })

  it('rejects when another step needs a fallback it did not need in the run', async () => {
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), ['save'], deps(() => replayed([at0('open'), at0('save'), { ...at0('done', 'role'), matched: { index: 1, selector: { css: 'p' }, layer: 'css', fallback: true } }])))
    expect(result.reason).toMatch(/Step done needed a fallback locator in the replay but not in run/)
    expect(readFileSync(file, 'utf8')).toBe(FLOW)
  })

  it('does not replay or write when the file changed since the run', async () => {
    writeFileSync(file, `${FLOW}# edited\n`)
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), undefined, deps(() => replayed([])))
    expect(result).toMatchObject({ applied: false, flow_status: 'changed' })
    expect(replays).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(`${FLOW}# edited\n`)
  })

  it('leaves a file edited during the replay as the editor left it', async () => {
    const result = await applyHeal(
      record([openDrifted, saveDrifted, doneStep]),
      undefined,
      deps(() => {
        writeFileSync(file, `${FLOW}# edited meanwhile\n`)
        return replayed([at0('open'), at0('save'), at0('done', 'role')])
      })
    )
    expect(result).toMatchObject({ applied: false, flow_status: 'changed' })
    expect(result.reason).toMatch(/changed while the proposed flow was being replayed/)
    expect(readFileSync(file, 'utf8')).toBe(`${FLOW}# edited meanwhile\n`)
    expect(readdirSync(dir)).toEqual(['notes.nawi.yaml'])
  })

  it('refuses a step with no proposal, with the reason from the report, without replaying', async () => {
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), ['done'], deps(() => replayed([])))
    expect(result.applied).toBe(false)
    expect(result.reason).toMatch(/No proposal for step done in run 20261107T130000000Z-abc123\. Steps with a proposal: open, save\./)
    expect(replays).toEqual([])
  })

  it('names why an unhealed step has no proposal', async () => {
    const visualOnly: RecordedStep = { ...saveDrifted, matched: { index: 2, selector: { image: 'x.png' } as never, layer: 'visual', fallback: true } }
    const result = await applyHeal(record([openDrifted, visualOnly, doneStep]), ['save'], deps(() => replayed([])))
    expect(result.reason).toMatch(/save: only its reference crop matched/)
  })

  it('has nothing to apply when no step drifted', async () => {
    const result = await applyHeal(record([doneStep]), undefined, deps(() => replayed([])))
    expect(result).toMatchObject({ applied: false, step_ids: [], diff: '' })
    expect(result.reason).toMatch(/nothing to apply/)
    expect(replays).toEqual([])
  })

  it('reports a missing flow file instead of throwing', async () => {
    rmSync(file)
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), undefined, deps(() => replayed([])))
    expect(result).toMatchObject({ applied: false, flow_status: 'missing' })
  })

  it('reports a write it could not make and leaves the file as it was', async () => {
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), undefined, {
      ...deps(() => replayed([at0('open'), at0('save'), at0('done', 'role')])),
      realPath: async () => join(dir, 'gone', 'notes.nawi.yaml')
    })
    expect(result.applied).toBe(false)
    expect(result.reason).toMatch(/cannot be written \(.*ENOENT/)
    expect(replays, 'no replay for a file that cannot be written').toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(FLOW)
  })

  it('keeps a world-writable mode the umask would strip', async () => {
    chmodSync(file, 0o666)
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), undefined, deps(() => replayed([at0('open'), at0('save'), at0('done', 'role')])))
    expect(result.applied).toBe(true)
    expect((statSync(file).mode & 0o777).toString(8)).toBe('666')
  })

  it.skipIf(process.getuid?.() === 0)('leaves a read-only flow alone (rename would replace it)', async () => {
    chmodSync(file, 0o444)
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), undefined, deps(() => replayed([at0('open'), at0('save'), at0('done', 'role')])))
    expect(result.applied).toBe(false)
    expect(result.reason).toMatch(/cannot be written \(.*EACCES/)
    expect(replays).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(FLOW)
  })

  it('leaves a file that is not UTF-8 alone: its other bytes would change', async () => {
    const latin1 = Buffer.concat([Buffer.from(FLOW, 'utf8'), Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a])])
    writeFileSync(file, latin1)
    const run = record([openDrifted, saveDrifted, doneStep])
    run.flow.sha256 = createHash('sha256').update(latin1).digest('hex')
    const result = await applyHeal(run, undefined, deps(() => replayed([at0('open'), at0('save'), at0('done', 'role')])))
    expect(result).toMatchObject({ applied: false, flow_status: 'current' })
    expect(result.reason).toMatch(/not valid UTF-8/)
    expect(readFileSync(file).equals(latin1), 'bytes untouched').toBe(true)
  })

  it('writes nothing when agent access is paused during the replay', async () => {
    const stop = new AbortController()
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), undefined, {
      ...deps(() => {
        stop.abort('agent access was paused in Nawi, so the remaining steps were not run')
        return replayed([at0('open'), at0('save'), at0('done', 'role')])
      }),
      signal: stop.signal
    })
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('Stopped before anything was written: agent access was paused in Nawi, so the remaining steps were not run.')
    expect(result.replay?.status).toBe('passed')
    expect(readFileSync(file, 'utf8')).toBe(FLOW)
  })

  it('does not start the replay when already stopped', async () => {
    const stop = new AbortController()
    stop.abort()
    const result = await applyHeal(record([openDrifted, saveDrifted, doneStep]), undefined, { ...deps(() => replayed([])), signal: stop.signal })
    expect(result.reason).toMatch(/^Stopped before anything was written: the call was cancelled\.$/)
    expect(replays).toEqual([])
  })
})

describe('judgeReplay', () => {
  const run = record([openDrifted, saveDrifted, doneStep])

  it('accepts a passed replay with the healed steps on their first locator', () => {
    expect(judgeReplay(run, ['open', 'save'], replayed([at0('open'), at0('save'), at0('done', 'role')]))).toBeNull()
  })

  it('does not count a fallback the run already had on a step that was not healed', () => {
    const openStill = { ...at0('open'), matched: { index: 1, selector: { css: '#open' }, layer: 'css' as const, fallback: true } }
    expect(judgeReplay(run, ['save'], replayed([openStill, at0('save'), at0('done', 'role')]))).toBeNull()
  })

  it('names the failing step and its error, or the run error when no step failed', () => {
    expect(judgeReplay(run, ['save'], replayed([at0('open'), at0('save'), { id: 'done', action: 'assert', status: 'failed', error: 'boom' }], { failed_step_id: 'done' }))).toMatch(/at step done when replayed \(boom\)/)
    expect(judgeReplay(run, ['save'], replayed([{ id: 'open', action: 'click', status: 'not_run' }], { status: 'failed', error: 'could not open the target' }))).toMatch(/failed when replayed \(could not open the target\)/)
  })

  it('rejects a healed step that the replay skipped or matched with no locator', () => {
    expect(judgeReplay(run, ['save'], replayed([at0('open'), { id: 'save', action: 'click', status: 'skipped' }, at0('done')]))).toMatch(/Healed step save did not pass in the replay \(skipped\)/)
    expect(judgeReplay(run, ['save'], replayed([at0('open'), { id: 'save', action: 'click', status: 'passed' }, at0('done')]))).toMatch(/matched through no recorded locator/)
  })
})
