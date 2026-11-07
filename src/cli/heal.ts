import type { HealReport } from '../main/heal/proposals'

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
  flow's folder (cd there; nawi heal <run_id> | git apply).
  Exit 0 with or without proposals, 1 when the run does not exist.`

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

/** One line per proposal and per step left unhealed, then the combined patch. */
export function renderHealReport(report: HealReport): string {
  const lines = [`Run ${report.run_id} of ${report.flow.name} (${report.flow.file})`]
  if (report.note) lines.push(report.note)
  if (report.proposals.length === 0 && report.flow_status === 'current') {
    lines.push(report.unhealed.length === 0 ? 'No step drifted: nothing to heal.' : 'No proposal: see the steps below.')
  }
  for (const p of report.proposals) {
    const dropped = p.dropped.map((d) => `${JSON.stringify(d.selector)} (${d.reason})`).join(', ')
    lines.push(`  ${p.step_id}: matched by ${p.layer} ${JSON.stringify(p.selectors_before[p.evidence.matched.index])}; drop ${dropped}`)
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
