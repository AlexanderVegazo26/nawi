/**
 * The `nawi` command table and the pure helpers behind `nawi tools` and
 * `nawi runs --follow` (roadmap AI11). No I/O and no `process` here, so the
 * parity test (`commands.test.ts`) can load it without Electron or a socket.
 */

/** Commands are a thin naming layer over the MCP tools; see `src/main/mcp/tools.ts`. */
export const COMMANDS: Record<string, { tool: string; summary: string }> = {
  capture: { tool: 'capture_screen', summary: 'Capture the whole screen.' },
  'capture-region': { tool: 'capture_region', summary: 'Capture a region: --x --y --width --height.' },
  'capture-element': { tool: 'capture_element', summary: 'Capture a page element: --selector.' },
  record: { tool: 'start_recording', summary: 'Start a screen recording.' },
  'record-stop': { tool: 'stop_recording', summary: 'Stop the active recording.' },
  get: { tool: 'get_capture', summary: 'Fetch one capture: --id.' },
  state: { tool: 'get_state_layer', summary: 'Read a capture\'s state layer (DOM, input, network, console): --capture_id.' },
  list: { tool: 'list_captures', summary: 'List captures in the library.' },
  search: { tool: 'search_captures', summary: 'Search captures: --query.' },
  annotate: { tool: 'annotate', summary: 'Add an annotation to a capture.' },
  redact: { tool: 'redact', summary: 'Redact a region of a capture.' },
  export: { tool: 'export_guide', summary: 'Export captures as a guide.' },
  'export-flow': { tool: 'export_flow', summary: 'Turn a recording into a flow file: --capture_id.' },
  run: { tool: 'run_flow', summary: 'Replay a flow file: nawi run <file> [--headless] [--var k=v]. Exit 1 if a step fails.' },
  runs: {
    tool: 'list_runs',
    summary:
      'List saved run records, newest first: [--limit 20] [--status failed] [--flow_file path]. ' +
      '--follow [--interval ms] streams new runs as NDJSON until interrupted.'
  },
  'run-info': { tool: 'get_run', summary: 'One run record in full: --run_id.' },
  heal: {
    tool: 'get_heal_proposals',
    summary: 'Propose locator fixes for a drifting flow from one saved run, as a YAML diff (nothing is written): nawi heal <run_id> [--json].'
  },
  'heal-apply': {
    tool: 'apply_heal',
    summary:
      'Write those proposals into the flow file once a replay of the proposed flow passes (a wrong match is rejected): ' +
      'nawi heal-apply <run_id> [--step id] [--headless] [--var k=v]. Exit 1 if nothing was written.'
  },
  'mobile-inspect': { tool: 'inspect_apk', summary: 'Read an Android app\'s manifest without installing it: nawi mobile-inspect <file.apk>.' },
  'mobile-doctor': {
    tool: 'mobile_doctor',
    summary: 'Check the Android SDK, adb, emulator, virtualization and devices, with one fix: nawi mobile-doctor [file.apk]. Exit 1 if nothing can run it.'
  },
  'mobile-open': {
    tool: 'mobile_open',
    summary: 'Install and start an Android app on a device (booting a virtual device if needed): nawi mobile-open <file.apk|profile>. Exit 1 if it is not running.'
  },
  'mobile-study': {
    tool: 'mobile_study',
    summary: 'Study the screen a connected Android device shows now: elements, locators, testability and accessibility findings, screenshot. Exit 1 if it could not.'
  },
  'mobile-explore': {
    tool: 'mobile_explore',
    summary: 'Explore the app a connected Android device shows now with safe taps and save its screen graph with findings per screen. Exit 1 if it could not.'
  }
}

/** `nawi tools` is answered by `tools/list`, not by a tool, so it has no entry in COMMANDS. */
export const TOOLS_COMMAND_SUMMARY = 'List every tool with its description and JSON Schema: [--json].'

/** Tool names that have a CLI command, for the CLI/MCP parity check. */
export function commandTools(): string[] {
  return Object.values(COMMANDS).map((c) => c.tool)
}

import type { ToolDescriptor } from '../main/mcp/dispatch'
export type { ToolDescriptor }

/** Reads the `tools` array of a `tools/list` result; anything else is a protocol error. */
export function toolDescriptors(result: unknown): ToolDescriptor[] {
  const tools = (result as { tools?: unknown } | null)?.tools
  if (!Array.isArray(tools)) throw new Error(`Nawi returned an unexpected tools/list result: ${JSON.stringify(result)?.slice(0, 300)}`)
  return (tools as Partial<ToolDescriptor>[]).filter((t): t is ToolDescriptor => typeof t?.name === 'string').map((t) => ({ ...t, description: typeof t.description === 'string' ? t.description : '' }))
}

/** One line per tool: the name, its CLI command (or "-"), and the first sentence of the description. */
export function renderTools(tools: ToolDescriptor[]): string {
  const byTool = new Map(Object.entries(COMMANDS).map(([cmd, c]) => [c.tool, cmd]))
  return tools
    .map((t) => {
      const first = t.description.split(/(?<=\.)\s/)[0] ?? ''
      return `${t.name.padEnd(18)}${(byTool.get(t.name) ?? '-').padEnd(16)}${first}`
    })
    .join('\n')
}

export interface RunSummary {
  run_id: string
  [key: string]: unknown
}

/**
 * The runs in `listed` (newest first, as list_runs returns them) that are not in `seen`, oldest first, so an
 * NDJSON consumer reads them in the order they happened. Adds them to `seen`.
 */
export function newRuns(seen: Set<string>, listed: RunSummary[]): RunSummary[] {
  const fresh: RunSummary[] = []
  for (const run of listed) {
    if (typeof run?.run_id !== 'string' || seen.has(run.run_id)) continue
    seen.add(run.run_id)
    fresh.push(run)
  }
  return fresh.reverse()
}

export interface FollowArgs {
  interval: number
  /** Passed to list_runs unchanged (limit, status, flow_file). */
  filter: Record<string, unknown>
}

export class FollowUsageError extends Error {}

export const FOLLOW_MIN_INTERVAL_MS = 200
/** list_runs' maximum limit (the number of records Nawi keeps). */
export const FOLLOW_WINDOW = 200

/** Splits `--follow` and `--interval` off the generic flags of `nawi runs`. */
export function parseFollow(args: Record<string, unknown>): FollowArgs | null {
  if (!('follow' in args)) {
    if ('interval' in args) throw new FollowUsageError('--interval only applies together with --follow.')
    return null
  }
  const { follow, interval, ...filter } = args
  if (follow !== true) throw new FollowUsageError('--follow takes no value.')
  // A window smaller than the burst would silently drop runs; the stream always polls the whole run store.
  if ('limit' in filter) throw new FollowUsageError('--limit cannot be combined with --follow (every new run is streamed).')
  const ms = interval === undefined ? 1000 : interval
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < FOLLOW_MIN_INTERVAL_MS || ms > 3_600_000) {
    throw new FollowUsageError(`--interval must be a whole number of milliseconds from ${FOLLOW_MIN_INTERVAL_MS} to 3600000.`)
  }
  return { interval: ms, filter: { ...filter, limit: FOLLOW_WINDOW } }
}
