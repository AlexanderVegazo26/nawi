// Runs one installer build for the release workflow, without signing variables that are set but empty.
//
//   node scripts/release-build.ts dist:mac        (also dist:win, dist:linux)
//
// The release workflow passes CSC_LINK, CSC_KEY_PASSWORD and the APPLE_* values from repository secrets. A secret
// that doesn't exist expands to an empty string, not to nothing, and electron-builder deliberately treats an empty
// CSC_LINK as "set" (platformPackager.getCscLink: "allow to specify as empty string"). On macOS it then resolves ""
// against the project directory and fails with "<repo> not a file", so an unsigned v0.1.0 tag never produced a
// macOS build. Dropping the empty ones makes an unsigned build the documented default again; a real secret is kept
// and signs as before.
import { spawnSync } from 'node:child_process'

/** Signing and notarization variables the workflow fills from secrets that may not exist. */
export const SIGNING_VARS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER'
] as const

/** Build scripts this wrapper may run (package.json `dist:*`); anything else is a usage error. */
export const BUILD_SCRIPTS = ['dist:win', 'dist:mac', 'dist:linux'] as const

/** A copy of `env` without the signing variables that are empty or only whitespace; every other entry is kept. */
export function withoutEmptySigningVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const name of SIGNING_VARS) {
    if (name in out && (out[name] ?? '').trim() === '') delete out[name]
  }
  return out
}

function main(argv: string[]): number {
  const script = argv[0]
  if (argv.length !== 1 || !(BUILD_SCRIPTS as readonly string[]).includes(script ?? '')) {
    console.error(`usage: node scripts/release-build.ts <${BUILD_SCRIPTS.join('|')}>`)
    return 2
  }
  const env = withoutEmptySigningVars(process.env)
  const dropped = SIGNING_VARS.filter((name) => name in process.env && !(name in env))
  if (dropped.length > 0) console.log(`release-build: unset empty ${dropped.join(', ')} (unsigned build)`)
  // One command string: `script` is one of BUILD_SCRIPTS, and a shell is what finds npm(.cmd) on Windows.
  const result = spawnSync(`npm run ${script}`, { stdio: 'inherit', env, shell: true })
  if (result.error) {
    console.error(`release-build: could not start npm: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
