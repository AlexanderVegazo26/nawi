/**
 * Every MCP tool the built app must publish: the FR-AGT.1 surface plus
 * `export_flow` (roadmap F2), `run_flow` (F3b), `list_runs`/`get_run` (F4c),
 * `get_heal_proposals`/`apply_heal` (self-healing), `inspect_apk` (M1a),
 * `mobile_doctor` (M1b), `mobile_open` (M1c), `mobile_study` (M3b),
 * `mobile_explore` (M3c2) and `mobile_record` (M5c).
 *
 * Named here, not imported from src/main/mcp/tools.ts, so the E2E kill-switch
 * test cannot quietly skip a tool the app stops publishing. The E2E suite only
 * runs weekly on CI, so src/main/mcp/e2e-tool-names.test.ts checks this list
 * against TOOLS in the unit suite: add a new tool here in the same change.
 *
 * Kept free of Playwright imports so that unit test can load it.
 */
export const E2E_TOOL_NAMES: readonly string[] = [
  'capture_screen',
  'capture_region',
  'capture_element',
  'start_recording',
  'stop_recording',
  'get_capture',
  'get_state_layer',
  'list_captures',
  'search_captures',
  'annotate',
  'redact',
  'export_guide',
  'export_flow',
  'run_flow',
  'list_runs',
  'get_run',
  'get_heal_proposals',
  'apply_heal',
  'inspect_apk',
  'mobile_doctor',
  'mobile_open',
  'mobile_study',
  'mobile_explore',
  'mobile_record'
]
