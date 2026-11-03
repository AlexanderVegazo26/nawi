/**
 * Chromium flags for the browsers the integration suites launch (tests only).
 *
 * - `--no-sandbox` on Linux: the AppArmor user-namespace restriction on current
 *   Ubuntu aborts a Playwright Chromium with SIGABRT before it opens a socket.
 * - `--password-store=basic` and `--use-mock-keychain`: keep the test browser
 *   off the host's OS keyring (Secret Service / KWallet on Linux, Keychain on
 *   macOS). Chromium fetches its cookie-encryption key from there before the
 *   first http(s) request, so a locked or slow keyring parks every navigation
 *   until `Page.navigate` times out (seen 2026-11-03: data: URLs loaded, any
 *   http URL hung, the local server never saw a request). A test must never
 *   depend on, or touch, the user's real keyring anyway.
 *
 * Product launches (`launchDebugBrowser` for users) do not use this list: a
 * real profile should keep its passwords in the OS keyring.
 */
export const TEST_BROWSER_ARGS: readonly string[] = [
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  '--password-store=basic',
  '--use-mock-keychain'
]
