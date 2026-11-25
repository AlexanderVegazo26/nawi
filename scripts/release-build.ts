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

/** Notarization inputs: meaningless (and fatal to the build) for an ad-hoc signed app. */
const NOTARIZE_VARS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] as const

/** True when `env` carries a certificate for electron-builder to sign with (after empty values were dropped). */
export function hasSigningCertificate(env: NodeJS.ProcessEnv): boolean {
  return ['CSC_LINK', 'CSC_NAME'].some((name) => (env[name] ?? '').trim() !== '')
}

/**
 * An unsigned macOS build is broken on Apple Silicon, not just unsigned. Electron's binaries ship ad-hoc signed;
 * electron-builder then renames the executable and rewrites Info.plist and the asar integrity hash, and with no
 * certificate it skips signing, so the bundle is left with a signature that no longer matches it and no
 * `_CodeSignature` seal. A downloaded copy fails Gatekeeper as "damaged" and may not launch at all (v0.1.0's
 * arm64 zip was exactly that: 29 ad-hoc Mach-O files, no seal).
 *
 * With no certificate, build the macOS app ad-hoc signed instead (`identity: "-"`), which re-seals the whole bundle.
 * The hardened runtime is turned off for that build: under it, library validation refuses to load the
 * ad-hoc-signed Electron Framework and the app dies at launch (electron-builder warns about this), and an ad-hoc
 * app cannot be notarized anyway. A real certificate keeps the config's hardened runtime and signs as before.
 */
export function macAdHocArgs(script: string, env: NodeJS.ProcessEnv): string[] {
  if (script !== 'dist:mac' || hasSigningCertificate(env)) return []
  return ['--', '-c.mac.identity=-', '-c.mac.hardenedRuntime=false']
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
  const adHoc = macAdHocArgs(script ?? '', env)
  if (adHoc.length > 0) {
    // Notarization needs a Developer ID signature; leaving its inputs set would fail an ad-hoc build late.
    for (const name of NOTARIZE_VARS) delete env[name]
    console.log('release-build: no signing certificate, building the macOS app ad-hoc signed (no hardened runtime)')
  }
  // One command string: `script` is one of BUILD_SCRIPTS, and a shell is what finds npm(.cmd) on Windows.
  const result = spawnSync(['npm', 'run', script, ...adHoc].join(' '), { stdio: 'inherit', env, shell: true })
  if (result.error) {
    console.error(`release-build: could not start npm: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
