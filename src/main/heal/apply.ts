import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { FlowRunReport } from '../flow-run'
import type { RunRecord } from '../run-record'
import { healedFlow, type FlowStatus } from './proposals'

/**
 * Roadmap F6, second slice: apply a healing proposal, but only after a replay
 * of the proposed flow shows it holds. The flow file is written only when
 *
 * - it is still the file the run replayed (sha256 of its bytes, checked again
 *   right before the write: a file edited during the replay is left alone);
 * - the replay of the proposed text passed as a whole (a wrong match usually
 *   shows up as a later step failing: clicking the wrong button);
 * - every healed step matched through its first locator, with no fallback;
 * - no step needed a fallback in the replay that did not need one in the run.
 *
 * The write is atomic (a temp file in the same folder, then rename), keeps the
 * file's mode, and changes only what the diff shows (the locator lines, unless
 * the list's layout forced proposals.ts to write the document out again). A
 * read-only file, a file that is not UTF-8 (its other bytes would change), and
 * a call stopped by the kill switch or the caller are never written.
 * Anything else is a normal "not applied" answer with the reason; the caller
 * decides how loud to be.
 */

/** One step of the replay, as much as a reviewer needs to see why it was accepted or not. */
export interface ReplayStep {
  id: string
  status: FlowRunReport['steps'][number]['status']
  matched?: { index: number; layer: string; fallback: boolean }
  error?: string
}

export interface ApplyHealResult {
  run_id: string
  flow: { name: string; file: string }
  flow_status: FlowStatus
  /** True only when the flow file now holds the healed text. */
  applied: boolean
  /** The steps whose proposals were (or would have been) applied. */
  step_ids: string[]
  /** The patch for those steps against the file as it was; '' when there was nothing to apply. */
  diff: string
  /** Why the file was not written. */
  reason?: string
  /** The replay of the proposed flow; absent when it never ran (nothing to apply, file changed...). */
  replay?: {
    status: FlowRunReport['status']
    failed_step_id?: string
    error?: string
    run_id?: string
    run_dir?: string
    steps: ReplayStep[]
  }
}

export interface ApplyHealDeps {
  /** Replays these flow bytes in place of the file's (runFlowFile with `source`). */
  replay(source: Buffer): Promise<FlowRunReport>
  /** Reads the flow file the run replayed, or null when it cannot (readRunFlow). */
  readFlow(): Promise<Buffer | null>
  /** The real path of that file, where the healed text is written. */
  realPath(): Promise<string>
  /** Agent access paused or the caller gone: nothing is written after it fires. */
  signal?: AbortSignal
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function replaySummary(report: FlowRunReport): NonNullable<ApplyHealResult['replay']> {
  return {
    status: report.status,
    ...(report.failed_step_id !== undefined ? { failed_step_id: report.failed_step_id } : {}),
    ...(report.error !== undefined ? { error: report.error } : {}),
    ...(report.run_id !== undefined ? { run_id: report.run_id, run_dir: report.run_dir } : {}),
    steps: report.steps.map((s) => ({
      id: s.id,
      status: s.status,
      ...(s.matched ? { matched: { index: s.matched.index, layer: s.matched.layer, fallback: s.matched.fallback } } : {}),
      ...(s.error !== undefined ? { error: s.error } : {})
    }))
  }
}

/**
 * Why the replay of the proposed flow does not support the heal, or null when
 * it does. Pure: compares the original run with the replay.
 */
export function judgeReplay(record: RunRecord, healed: string[], replay: FlowRunReport): string | null {
  if (replay.status !== 'passed') {
    const at = replay.failed_step_id !== undefined ? ` at step ${replay.failed_step_id}` : ''
    const why = replay.error ?? replay.steps.find((s) => s.id === replay.failed_step_id)?.error
    return `The proposed flow failed${at} when replayed${why ? ` (${why})` : ''}, so the locator it moves to the front may find the wrong element. Nothing was written.`
  }
  for (const id of healed) {
    const step = replay.steps.find((s) => s.id === id)
    if (!step || step.status !== 'passed') return `Healed step ${id} did not pass in the replay (${step?.status ?? 'missing'}). Nothing was written.`
    if (!step.matched || step.matched.index !== 0 || step.matched.fallback) {
      const how = step.matched ? `locator ${step.matched.index + 1} (${step.matched.layer}${step.matched.fallback ? ', fallback' : ''})` : 'no recorded locator'
      return `Healed step ${id} matched through ${how} in the replay, not its new first locator. Nothing was written.`
    }
  }
  for (const step of replay.steps) {
    if (healed.includes(step.id) || !step.matched?.fallback) continue
    const before = record.steps.find((s) => s.id === step.id)
    if (!before || before.status === 'not_run' || before.status === 'skipped') {
      // After a healed failure the replay reaches steps the run never did: their drift may be old, or the heal
      // may have led somewhere else; one replay cannot tell, so it is not written either way.
      return (
        `Step ${step.id} needed a fallback locator in the replay; it never ran in run ${record.run_id} (it came after the failure), ` +
        'so this replay cannot tell older drift there from a heal that led somewhere else. Nothing was written: review the diff and apply it yourself, ' +
        'then run the flow again and heal from that run.'
      )
    }
    if (!before?.matched?.fallback) {
      return `Step ${step.id} needed a fallback locator in the replay but not in run ${record.run_id}. Nothing was written.`
    }
  }
  return null
}

/** Writes `text` over `file` through a temp file in the same folder, only while the file still hashes to `sha`. */
async function writeIfUnchanged(file: string, sha: string, text: string): Promise<boolean> {
  const stat = await fs.stat(file)
  if (sha256(await fs.readFile(file)) !== sha) return false
  const tmp = join(dirname(file), `.${basename(file)}.heal-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmp, text, { flag: 'wx', mode: 0o600 })
    // Set explicitly: the create mode is masked by the umask (a group-writable flow would lose group write).
    await fs.chmod(tmp, stat.mode & 0o7777)
    // Checked again just before the swap: the replay can take a while.
    if (sha256(await fs.readFile(file)) !== sha) return false
    await fs.rename(tmp, file)
    return true
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

/** apply_heal: proposals for `stepIds` (all when undefined), replayed, then written if the replay holds. */
export async function applyHeal(record: RunRecord, stepIds: string[] | undefined, deps: ApplyHealDeps): Promise<ApplyHealResult> {
  const bytes = await deps.readFlow()
  const { report, step_ids, missing, text, diff } = healedFlow(record, bytes, stepIds)
  const base = { run_id: record.run_id, flow: report.flow, flow_status: report.flow_status, step_ids }
  const notApplied = (reason: string, extra: Partial<ApplyHealResult> = {}): ApplyHealResult => ({
    ...base,
    applied: false,
    diff,
    reason,
    ...extra
  })

  if (report.flow_status !== 'current') return notApplied(report.note ?? `The flow file is ${report.flow_status}.`)
  if (missing.length > 0) {
    const unhealed = missing.map((id) => report.unhealed.find((u) => u.step_id === id)).filter((u) => u !== undefined)
    const why = unhealed.map((u) => `${u.step_id}: ${u.reason}`).join('; ')
    return notApplied(
      `No proposal for step ${missing.join(', ')} in run ${record.run_id}${why ? ` (${why})` : ''}. ` +
        `Steps with a proposal: ${report.proposals.map((p) => p.step_id).join(', ') || 'none'}.`
    )
  }
  if (text === null) return notApplied(step_ids.length === 0 ? 'No step drifted in this run: nothing to apply.' : 'The proposals could not be combined into one flow.')
  // The patch is made on the file decoded as UTF-8: bytes that are not would be rewritten outside the diff.
  if (bytes && !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    return notApplied('The flow file is not valid UTF-8, so writing the patch would change bytes outside the diff. Apply the diff yourself.')
  }
  let real: string
  try {
    real = await deps.realPath()
    await fs.access(real, fsConstants.W_OK)
  } catch (error) {
    return notApplied(`The flow file cannot be written (${error instanceof Error ? error.message : String(error)}), so the proposed flow was not replayed. Nothing was written.`)
  }
  const stopped = (): ApplyHealResult | null =>
    deps.signal?.aborted
      ? notApplied(`Stopped before anything was written: ${typeof deps.signal.reason === 'string' ? deps.signal.reason : 'the call was cancelled'}.`)
      : null
  const early = stopped()
  if (early) return early

  const replay = await deps.replay(Buffer.from(text, 'utf8'))
  const summary = replaySummary(replay)
  const rejected = judgeReplay(record, step_ids, replay)
  if (rejected) return notApplied(rejected, { replay: summary })

  const late = stopped()
  if (late) return { ...late, replay: summary }
  let written: boolean
  try {
    written = await writeIfUnchanged(real, record.flow.sha256, text)
  } catch (error) {
    return notApplied(`The flow file could not be written: ${error instanceof Error ? error.message : String(error)}. It was left as it is.`, {
      replay: summary
    })
  }
  if (!written) {
    return notApplied('The flow file changed while the proposed flow was being replayed, so it was left as it is. Run the flow again and ask for proposals from that run.', {
      flow_status: 'changed',
      replay: summary
    })
  }
  return { ...base, applied: true, diff, replay: summary }
}
