/**
 * Serve mode (roadmap AI11): the engine without a window, for `nawi serve`.
 *
 * The app started with `--serve` opens no window, binds no global hotkeys and
 * keeps running when it has no windows; it exists only to answer the loopback
 * agent endpoint (MCP / CLI). Electron-free so the rules are unit-testable.
 */

/** The app-side switch `nawi serve` passes. Not `--headless`: that is `nawi run`'s flag for the replay browser. */
export const SERVE_FLAG = '--serve'

/** Exit code when serve mode cannot offer its endpoint (the CLI's "environment" code). */
export const SERVE_EXIT_NO_ENDPOINT = 3

export function isServeMode(argv: readonly string[]): boolean {
  return argv.includes(SERVE_FLAG)
}

/** The one line serve mode prints once the endpoint is up; scripts may wait for it. The token is never printed. */
export function serveReadyLine(info: { url: string; pid: number }): string {
  return `nawi serve: ready on ${info.url} (pid ${info.pid}, loopback only). Ctrl-C or SIGTERM stops it.`
}
