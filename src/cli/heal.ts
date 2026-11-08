import type { HealReport } from '../main/heal/proposals'
import type { ApplyHealResult } from '../main/heal/apply'
import { STEP_TIMEOUT_RANGE } from './run'

/**
 * `nawi heal <run_id> [--json]` (roadmap F6): the CLI half of
 * `get_heal_proposals`. Pure, so the argument handling and the text output are
 * tested without a running app. Prints the proposals and the YAML diff; never
 * writes the flow file.
 */

export const HEAL_USAGE = `nawi heal <run_id> [--json]

  Proposes locator fixes for a flow that is drifting from the app, from one saved run (see nawi runs):
  each step that passed only through a fallback locator gets the locator that matched moved to the
  front and the ones that found nothing dropped. Prints one line per step and the YAML diff against
  the flow file; nothing is written. The diff names the file without its folder: apply it from the
  flow's folder (cd there; nawi heal <run_id> | git apply), or let Nawi apply it (nawi heal-apply).
  Exit 0 with or without proposals, 1 when the run does not exist.`

export const HEAL_APPLY_USAGE = `nawi heal-apply <run_id> [--step <id> ...] [--headless] [--var name=value ...] [--cdp-endpoint 9222]
                       [--step-timeout-ms 5000] [--json]
  (also: nawi heal <run_id> --apply ...)

  Writes the proposals nawi heal shows into the flow file, after replaying the proposed flow: the file is
  written only when that replay passes, each healed step matches through its new first locator and no
  other step needs a fallback it did not need before (a wrong match is rejected). Only what the printed
  diff shows changes. --step limits it to these steps (repeatable; default every proposal). The replay is
  saved as a run record. Inputs as in nawi run (--var; env and NAWI_SECRET_* for the names the flow uses).
  Exit 0 when the file was written, 1 when it was not (the reason is printed) or the run does not exist.`

/** run-record.ts's RUN_ID_RE (the CLI bundles no app code; heal.test.ts keeps the two equal). */
export const RUN_ID_RE = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/

export class HealUsageError extends Error {}

export function parseHealArgs(argv: string[]): { run_id: string; json: boolean } {
  let runId: string | undefined
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--json') json = true
    else if (token === '--run_id' || token === '--run-id') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new HealUsageError(`${token} needs a value.`)
      if (runId !== undefined) throw new HealUsageError('Give one run id.')
      runId = v
    } else if (token.startsWith('--')) throw new HealUsageError(`Unknown flag ${token}.`)
    else if (runId !== undefined) throw new HealUsageError('Give one run id.')
    else runId = token
  }
  if (runId === undefined) throw new HealUsageError('nawi heal needs a run id (see nawi runs).')
  if (!RUN_ID_RE.test(runId)) throw new HealUsageError(`"${runId}" is not a run id such as 20261102T103900123Z-a1b2c3 (see nawi runs).`)
  return { run_id: runId, json }
}

export interface HealApplyArgs {
  run_id: string
  step_ids?: string[]
  vars: Record<string, string>
  headless: boolean
  cdp_endpoint?: string
  step_timeout_ms?: number
  json: boolean
}

/** `heal-apply`'s flags (and `heal --apply`'s: the `--apply` token is accepted and ignored here). */
export function parseHealApplyArgs(argv: string[]): HealApplyArgs {
  let runId: string | undefined
  const steps: string[] = []
  const out: Omit<HealApplyArgs, 'run_id' | 'step_ids'> = { vars: {}, headless: false, json: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new HealUsageError(`${flag} needs a value.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--apply') continue
    else if (token === '--json') out.json = true
    else if (token === '--headless') out.headless = true
    else if (token === '--step') steps.push(value(i++, '--step'))
    else if (token === '--var') {
      const pair = value(i++, '--var')
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new HealUsageError(`--var takes name=value, got "${pair}".`)
      out.vars[pair.slice(0, eq)] = pair.slice(eq + 1)
    } else if (token === '--cdp-endpoint') out.cdp_endpoint = value(i++, '--cdp-endpoint')
    else if (token === '--step-timeout-ms') {
      const raw = value(i++, '--step-timeout-ms')
      const ms = Number(raw)
      // As nawi run checks it, so the two commands take the same values.
      if (!Number.isInteger(ms) || ms < STEP_TIMEOUT_RANGE.min || ms > STEP_TIMEOUT_RANGE.max) {
        throw new HealUsageError(`--step-timeout-ms takes a whole number from ${STEP_TIMEOUT_RANGE.min} to ${STEP_TIMEOUT_RANGE.max}, got "${raw}".`)
      }
      out.step_timeout_ms = ms
    } else if (token === '--run_id' || token === '--run-id') {
      if (runId !== undefined) throw new HealUsageError('Give one run id.')
      runId = value(i++, token)
    } else if (token.startsWith('--')) throw new HealUsageError(`Unknown flag ${token}.`)
    else if (runId !== undefined) throw new HealUsageError('Give one run id.')
    else runId = token
  }
  if (runId === undefined) throw new HealUsageError('nawi heal-apply needs a run id (see nawi runs).')
  if (!RUN_ID_RE.test(runId)) throw new HealUsageError(`"${runId}" is not a run id such as 20261102T103900123Z-a1b2c3 (see nawi runs).`)
  return { run_id: runId, ...(steps.length > 0 ? { step_ids: steps } : {}), ...out }
}

/** What happened, the replay's steps, then the patch (written or not). */
export function renderApplyHeal(result: ApplyHealResult): string {
  const steps = result.step_ids.join(', ') || 'none'
  const lines = [
    result.applied
      ? `Healed ${steps} in ${result.flow.file} (run ${result.run_id}).`
      : `Not applied (run ${result.run_id}, ${result.flow.file}): ${result.reason ?? 'no reason given'}`
  ]
  if (result.replay) {
    lines.push(`Replay of the proposed flow: ${result.replay.status}${result.replay.run_id ? ` (run ${result.replay.run_id})` : ''}`)
    for (const s of result.replay.steps) {
      const how = s.matched ? `, locator ${s.matched.index + 1} (${s.matched.layer}${s.matched.fallback ? ', fallback' : ''})` : ''
      lines.push(`  ${s.id}: ${s.status}${how}${s.error ? `: ${s.error}` : ''}`)
    }
  }
  if (result.diff) lines.push('', result.diff.trimEnd())
  return lines.join('\n')
}

/** Checks the shape the CLI reads, so a mismatched app version is an error, not a crash. */
export function isApplyHealResult(value: unknown): value is ApplyHealResult {
  const r = value as Partial<ApplyHealResult> | null
  return (
    !!r &&
    typeof r.run_id === 'string' &&
    typeof r.flow?.file === 'string' &&
    typeof r.applied === 'boolean' &&
    Array.isArray(r.step_ids) &&
    typeof r.diff === 'string'
  )
}

/** One line per proposal and per step left unhealed, then the combined patch. */
export function renderHealReport(report: HealReport): string {
  const lines = [`Run ${report.run_id} of ${report.flow.name} (${report.flow.file})`]
  if (report.note) lines.push(report.note)
  if (report.proposals.length === 0 && report.flow_status === 'current') {
    lines.push(report.unhealed.length === 0 ? 'No step drifted: nothing to heal.' : 'No proposal: see the steps below.')
  }
  for (const p of report.proposals) {
    const dropped = p.dropped.map((d) => `${JSON.stringify(d.selector)} (${d.reason})`).join(', ')
    const added = p.added ?? []
    const suggested = p.evidence.suggested
    const how =
      p.layer === 'suggested'
        ? `failed, nothing matched; suggested from ${suggested?.basis === 'locators' ? "its locators' names" : 'its intent'}: ${suggested?.role || 'control'} "${suggested?.name ?? ''}" (score ${suggested?.score ?? '?'}); ${added.length > 0 ? `add ${added.map((s) => JSON.stringify(s)).join(', ')}` : `move ${JSON.stringify(p.selectors_after[0])} to the front`} (UNVERIFIED: a guess from names, review it; apply_heal replays it first)`
        : p.layer !== 'visual'
        ? `matched by ${p.layer} ${JSON.stringify(p.selectors_before[p.evidence.matched?.index ?? 0])}`
        : added.length > 0
          ? `matched by its reference crop; add ${added.map((s) => JSON.stringify(s)).join(', ')} (unverified until replayed)`
          : `matched by its reference crop; move ${JSON.stringify(p.selectors_after[0])} to the front`
    lines.push(`  ${p.step_id}: ${how}${dropped ? `; drop ${dropped}` : ''}`)
  }
  for (const u of report.unhealed) lines.push(`  ${u.step_id}: not healed, ${u.reason}`)
  if (report.diff) lines.push('', report.diff.trimEnd())
  return lines.join('\n')
}

/** Checks the shape the CLI reads, so a mismatched app version is an error, not a crash. */
export function isHealReport(value: unknown): value is HealReport {
  const r = value as Partial<HealReport> | null
  return (
    !!r &&
    typeof r.run_id === 'string' &&
    typeof r.flow?.name === 'string' &&
    typeof r.flow.file === 'string' &&
    typeof r.flow_status === 'string' &&
    Array.isArray(r.proposals) &&
    Array.isArray(r.unhealed) &&
    typeof r.diff === 'string'
  )
}
