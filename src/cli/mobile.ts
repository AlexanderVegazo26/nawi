import { resolve } from 'node:path'
import type { ApkInfo } from '../main/mobile/apk'

/**
 * `nawi mobile-inspect <file.apk>` — the CLI half of the `inspect_apk` tool (roadmap M1). Pure functions so the
 * argument handling and the output are unit-tested without a running app. Like `nawi run`, the only thing added
 * over the generic command path is a positional file resolved against the shell's folder (the app's cwd is not
 * the user's).
 */

export const MOBILE_INSPECT_USAGE = `nawi mobile-inspect <file.apk> [--json]

  Reads an Android app package without installing it: package, versions, SDK levels, launcher activity,
  native ABIs, debuggable, permissions (runtime ones marked), deep links and exported components.
  An .aab is refused with the bundletool command that converts it.`

export class MobileUsageError extends Error {}

export function parseMobileInspectArgs(argv: string[], cwd: string): { file: string; json: boolean } {
  let file: string | undefined
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--file') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new MobileUsageError('--file needs a path.')
      if (file !== undefined) throw new MobileUsageError('Give one APK file.')
      file = v
    } else if (a.startsWith('--')) throw new MobileUsageError(`Unknown flag ${a}.`)
    else if (file !== undefined) throw new MobileUsageError('Give one APK file.')
    else file = a
  }
  if (file === undefined) throw new MobileUsageError('Which APK? nawi mobile-inspect <file.apk>')
  return { file: resolve(cwd, file), json }
}

/** A terminal summary of an inspect_apk result; `--json` prints the object itself. */
export function renderApkInfo(info: ApkInfo): string {
  const version = [info.version_name, info.version_code !== null ? `(${info.version_code})` : null].filter(Boolean).join(' ')
  const lines = [
    `${info.package}${version ? ` ${version}` : ''}`,
    `  SDK          min ${info.min_sdk}, target ${info.target_sdk}`,
    `  launcher     ${info.launcher_activity ?? '(none: the app has no launcher activity)'}`,
    `  ABIs         ${info.abis.length ? info.abis.join(', ') : 'any (no native code)'}`,
    `  debuggable   ${info.debuggable ? 'yes' : 'no'}`
  ]
  const runtime = info.permissions.filter((p) => p.runtime)
  lines.push(`  permissions  ${info.permissions.length} (${runtime.length} runtime${runtime.length ? `: ${runtime.map((p) => p.name.replace(/^android\.permission\./, '')).join(', ')}` : ''})`)
  if (info.deep_links.length === 0) lines.push('  deep links   none')
  else {
    lines.push(`  deep links   ${info.deep_links.length}`)
    for (const d of info.deep_links) lines.push(`    ${d.uri}${d.auto_verify ? ' (verified)' : ''} -> ${d.component}`)
  }
  if (info.exported_components.length === 0) lines.push('  exported     none')
  else {
    lines.push(`  exported     ${info.exported_components.length}`)
    for (const c of info.exported_components) lines.push(`    ${c.kind} ${c.name}${c.why === 'intent-filter' ? ' (implicit: intent filter, no android:exported)' : ''}`)
  }
  if (info.unresolved.length > 0) {
    lines.push(`  unresolved   ${info.unresolved.length} (resource references, not read yet)`)
    for (const u of info.unresolved) lines.push(`    ${u}`)
  }
  return lines.join('\n')
}
