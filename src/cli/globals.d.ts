/**
 * Build-time constant injected by `define` in electron.vite.config.ts.
 *
 * The CLI reports `--version` from this rather than importing package.json:
 * the packaged CLI runs from `app.asar.unpacked/out/cli/`, where a relative
 * `require('../../package.json')` resolves to a path that may or may not exist
 * depending on how the archive was unpacked. Inlining the literal at build time
 * has no runtime lookup to get wrong.
 */
declare const __APP_VERSION__: string
