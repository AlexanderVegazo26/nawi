import { constants as fsc, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { within } from '../confine'
import { androidAttr, isReference, parseAxml, plainAttr, type AndroidAttr, type AxmlElement, type AxmlValue } from './axml'
import { ApkError, corrupt } from './errors'
import { detectFramework, type FrameworkInfo } from './framework'
import { readCentralDirectory, readEntry, type ByteSource, type ZipEntry } from './zip'

/**
 * Roadmap M1 (first slice): what Nawi needs to know about an Android app before it installs and drives it, read
 * offline from the .apk alone, with no Android SDK on the machine. Electron-free, so the CLI, MCP and tests share it.
 */

export interface ApkPermission {
  name: string
  /** A runtime ("dangerous") permission: M1's setup grants these with `pm grant` so no dialog blocks a run. */
  runtime: boolean
  /** Requested only up to this API level (android:maxSdkVersion), when set. */
  max_sdk: number | null
}

export interface ApkDeepLink {
  /** The activity (or alias) that opens it. */
  component: string
  /** e.g. `https://example.com/invite*` (pathPrefix is shown with a trailing `*`), or `myapp://open`. */
  uri: string
  /** android:autoVerify on its intent filter (an App Link the system verifies for the domain). */
  auto_verify: boolean
}

export type ComponentKind = 'activity' | 'activity-alias' | 'service' | 'receiver' | 'provider'

export interface ApkExportedComponent {
  kind: ComponentKind
  name: string
  /** explicit: android:exported="true"; intent-filter: no android:exported but an intent filter (implicitly exported before API 31). */
  why: 'explicit' | 'intent-filter'
}

export interface ApkInfo {
  package: string
  version_code: number | null
  version_name: string | null
  min_sdk: number
  target_sdk: number
  /** The activity a launcher starts (`am start -n <package>/<launcher_activity>`), or null for an app with none. */
  launcher_activity: string | null
  /** Native code ABIs (lib/<abi>/*.so). Empty: no native code, so it runs on any device ABI. */
  abis: string[]
  debuggable: boolean
  permissions: ApkPermission[]
  deep_links: ApkDeepLink[]
  exported_components: ApkExportedComponent[]
  /** The UI framework (native, Flutter, React Native, WebView) and how Nawi reads its screen (roadmap M2). */
  framework: FrameworkInfo
  /**
   * Values the manifest takes from the app's resources (`@string/...`), which this reader does not resolve, so they
   * are left out above rather than shown as a raw id: e.g. "deep link host of com.x.Links (@0x7f120034)".
   */
  unresolved: string[]
}

/** The compiled manifest is a few KB; a 4 MiB cap is generous and stops a zip bomb. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
/** Uris listed per intent filter: a filter with many schemes x hosts x paths would otherwise multiply out. */
export const MAX_URIS_PER_FILTER = 50

/** Platform runtime permissions (protectionLevel dangerous), as of API 36. */
const RUNTIME_PERMISSIONS = new Set(
  [
    'ACCEPT_HANDOVER', 'ACCESS_BACKGROUND_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION',
    'ACCESS_MEDIA_LOCATION', 'ACTIVITY_RECOGNITION', 'ADD_VOICEMAIL', 'ANSWER_PHONE_CALLS', 'BLUETOOTH_ADVERTISE',
    'BLUETOOTH_CONNECT', 'BLUETOOTH_SCAN', 'BODY_SENSORS', 'BODY_SENSORS_BACKGROUND', 'CALL_PHONE', 'CAMERA',
    'GET_ACCOUNTS', 'NEARBY_WIFI_DEVICES', 'POST_NOTIFICATIONS', 'PROCESS_OUTGOING_CALLS', 'READ_CALENDAR',
    'READ_CALL_LOG', 'READ_CONTACTS', 'READ_EXTERNAL_STORAGE', 'READ_MEDIA_AUDIO', 'READ_MEDIA_IMAGES',
    'READ_MEDIA_VIDEO', 'READ_MEDIA_VISUAL_USER_SELECTED', 'READ_PHONE_NUMBERS', 'READ_PHONE_STATE', 'READ_SMS',
    'RECEIVE_MMS', 'RECEIVE_SMS', 'RECEIVE_WAP_PUSH', 'RECORD_AUDIO', 'SEND_SMS', 'USE_SIP', 'UWB_RANGING',
    'WRITE_CALENDAR', 'WRITE_CALL_LOG', 'WRITE_CONTACTS', 'WRITE_EXTERNAL_STORAGE'
  ].map((p) => `android.permission.${p}`)
)

const COMPONENT_KINDS: readonly ComponentKind[] = ['activity', 'activity-alias', 'service', 'receiver', 'provider']
const ACTION_MAIN = 'android.intent.action.MAIN'
const ACTION_VIEW = 'android.intent.action.VIEW'
const CATEGORY_LAUNCHER = 'android.intent.category.LAUNCHER'
const CATEGORY_BROWSABLE = 'android.intent.category.BROWSABLE'

const str = (v: AxmlValue | undefined): string | null => (typeof v === 'string' && v.length > 0 && !isReference(v) ? v : null)
const int = (v: AxmlValue | undefined): number | null => {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return null
}
const isTrue = (v: AxmlValue | undefined): boolean => v === true || v === 'true'
const childrenNamed = (el: AxmlElement, name: string): AxmlElement[] => el.children.filter((c) => c.name === name)

/** `.Main` and `Main` are relative to the package; anything with a dot inside is already a full class name. */
export function resolveClassName(name: string, pkg: string): string {
  if (name.startsWith('.')) return pkg + name
  return name.includes('.') ? name : `${pkg}.${name}`
}

function filterNames(filter: AxmlElement, tag: 'action' | 'category'): string[] {
  return childrenNamed(filter, tag).flatMap((e) => str(androidAttr(e, 'name')) ?? [])
}

/**
 * The URIs an intent filter matches: <data> elements in one filter combine (every scheme x every host x every path),
 * which is how Android itself reads them.
 */
function filterUris(filter: AxmlElement, value: (el: AxmlElement, attr: AndroidAttr) => string | null): string[] {
  const schemes = new Set<string>()
  const hosts = new Set<string>()
  const paths = new Set<string>()
  for (const d of childrenNamed(filter, 'data')) {
    const scheme = value(d, 'scheme')
    if (scheme) schemes.add(scheme)
    const host = value(d, 'host')
    if (host) {
      const port = value(d, 'port') ?? int(androidAttr(d, 'port'))
      hosts.add(port !== null ? `${host}:${port}` : host)
    }
    const path = value(d, 'path')
    if (path) paths.add(path)
    const prefix = value(d, 'pathPrefix')
    if (prefix) paths.add(`${prefix}*`)
    const pattern = value(d, 'pathPattern')
    if (pattern) paths.add(pattern)
  }
  // Built with an early stop: a hostile filter's schemes x hosts x paths product must not be materialised.
  const uris: string[] = []
  const add = (uri: string): boolean => uris.push(uri) >= MAX_URIS_PER_FILTER
  for (const s of schemes) {
    if (hosts.size === 0 && add(`${s}:`)) return uris
    for (const h of hosts) {
      if (paths.size === 0 && add(`${s}://${h}`)) return uris
      // Android matches paths against a path that starts with '/', so a pattern like `.*` is shown as `/.*`.
      for (const p of paths) if (add(`${s}://${h}${p.startsWith('/') ? '' : '/'}${p}`)) return uris
    }
  }
  return uris
}

/** Reads the facts M1 and M2 need from a parsed manifest and the archive's entry names. */
export function describeManifest(manifest: AxmlElement, entryNames: readonly string[]): ApkInfo {
  if (manifest.name !== 'manifest') throw corrupt(`the manifest's root element is <${manifest.name}>, not <manifest>`)
  const pkg = str(plainAttr(manifest, 'package'))
  if (!pkg) throw corrupt('the manifest names no package')
  const unresolved: string[] = []
  /** A text attribute, or null; a resource reference is noted in `unresolved` instead of being returned. */
  const text = (el: AxmlElement, attr: AndroidAttr, what: string): string | null => {
    const v = androidAttr(el, attr)
    if (isReference(v)) unresolved.push(`${what} (${v})`)
    return str(v)
  }

  const usesSdk = childrenNamed(manifest, 'uses-sdk')[0]
  const minSdk = (usesSdk && int(androidAttr(usesSdk, 'minSdkVersion'))) ?? 1
  const targetSdk = (usesSdk && int(androidAttr(usesSdk, 'targetSdkVersion'))) ?? minSdk

  const permissions = new Map<string, ApkPermission>()
  for (const p of [...childrenNamed(manifest, 'uses-permission'), ...childrenNamed(manifest, 'uses-permission-sdk-23')]) {
    const name = str(androidAttr(p, 'name'))
    if (!name || permissions.has(name)) continue
    permissions.set(name, { name, runtime: RUNTIME_PERMISSIONS.has(name), max_sdk: int(androidAttr(p, 'maxSdkVersion')) })
  }

  const app = childrenNamed(manifest, 'application')[0]
  let launcher: string | null = null
  const deepLinks: ApkDeepLink[] = []
  const exported: ApkExportedComponent[] = []
  for (const el of app?.children ?? []) {
    const kind = COMPONENT_KINDS.find((k) => k === el.name)
    const rawName = str(androidAttr(el, 'name'))
    // A disabled component never runs, so it is neither exported nor a launcher or link target.
    if (!kind || !rawName || androidAttr(el, 'enabled') === false) continue
    const name = resolveClassName(rawName, pkg)
    const filters = childrenNamed(el, 'intent-filter')
    const exportedAttr = androidAttr(el, 'exported')
    if (isTrue(exportedAttr)) exported.push({ kind, name, why: 'explicit' })
    else if (exportedAttr === undefined && filters.length > 0) exported.push({ kind, name, why: 'intent-filter' })

    if (kind !== 'activity' && kind !== 'activity-alias') continue
    for (const f of filters) {
      const actions = filterNames(f, 'action')
      const categories = filterNames(f, 'category')
      if (!launcher && actions.includes(ACTION_MAIN) && categories.includes(CATEGORY_LAUNCHER)) launcher = name
      if (actions.includes(ACTION_VIEW) && categories.includes(CATEGORY_BROWSABLE)) {
        const autoVerify = isTrue(androidAttr(f, 'autoVerify'))
        const value = (d: AxmlElement, attr: AndroidAttr): string | null => text(d, attr, `deep link ${attr} of ${name}`)
        const before = unresolved.length
        const uris = filterUris(f, value)
        // A filter with an unresolved part (say the host) would print a wrong URI such as `https:`: list none of it.
        if (unresolved.length > before) continue
        for (const uri of uris) deepLinks.push({ component: name, uri, auto_verify: autoVerify })
      }
    }
  }

  const abis = new Set<string>()
  for (const n of entryNames) {
    const m = /^lib\/([^/]+)\/[^/]+\.so$/.exec(n)
    if (m) abis.add(m[1])
  }

  const debuggable = app !== undefined && isTrue(androidAttr(app, 'debuggable'))
  return {
    package: pkg,
    version_code: int(androidAttr(manifest, 'versionCode')),
    version_name: text(manifest, 'versionName', 'versionName'),
    min_sdk: minSdk,
    target_sdk: targetSdk,
    launcher_activity: launcher,
    abis: [...abis].sort(),
    debuggable,
    permissions: [...permissions.values()],
    deep_links: deepLinks,
    exported_components: exported,
    framework: detectFramework(entryNames, debuggable),
    unresolved
  }
}

function isBundle(entries: readonly ZipEntry[]): boolean {
  return entries.some((e) => e.name === 'BundleConfig.pb' || e.name === 'base/manifest/AndroidManifest.xml')
}

/** Inspects an APK given as random-access bytes. */
export async function inspectApk(src: ByteSource): Promise<ApkInfo> {
  const entries = await readCentralDirectory(src)
  const manifest = entries.find((e) => e.name === 'AndroidManifest.xml')
  if (!manifest) {
    if (isBundle(entries)) {
      throw new ApkError(
        'unsupported',
        'This is an Android App Bundle (.aab); Nawi reads installable APKs only so far.',
        'Convert it with bundletool: `bundletool build-apks --bundle app.aab --output app.apks --mode=universal`, then unzip universal.apk from app.apks.'
      )
    }
    throw corrupt('it has no AndroidManifest.xml (it is a zip archive, but not an Android app)')
  }
  const tree = parseAxml(await readEntry(src, manifest, MAX_MANIFEST_BYTES))
  return describeManifest(tree, entries.map((e) => e.name))
}

const APK_SUFFIXES = ['.apk', '.aab']

/** A file that exists but the OS will not let Nawi read (EACCES, EIO, ...). */
function unreadable(file: string, err: unknown): ApkError {
  const code = (err as NodeJS.ErrnoException)?.code ?? 'error'
  return new ApkError('invalid', `Nawi cannot read ${file} (${code}).`, 'Check that your user can read the file and its folders (e.g. `chmod u+r` on the file).')
}

/**
 * Inspects an APK on disk. The path must be absolute, end in .apk (or .aab, which gets the bundletool fix), and
 * resolve (symlinks followed) to a file inside one of `roots` (the user's home by default), the same confinement
 * flow files have: an agent cannot use this to probe arbitrary files.
 */
export async function inspectApkFile(file: string, roots: string[] = [homedir()]): Promise<ApkInfo> {
  if (!isAbsolute(file)) throw new ApkError('invalid', 'The APK path must be absolute.', 'Pass the full path, e.g. /home/you/Downloads/app.apk.')
  const hasSuffix = (p: string): boolean => APK_SUFFIXES.some((s) => p.toLowerCase().endsWith(s))
  if (!hasSuffix(file)) throw new ApkError('invalid', 'Only Android packages (*.apk) can be inspected.', 'Pass the path of an .apk file.')
  let real: string
  try {
    real = await fs.realpath(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ApkError('not_found', `No file exists at ${file}.`, 'Check the path; the CLI resolves a relative path against the current folder.')
    }
    throw unreadable(file, err)
  }
  const realRoots = await Promise.all(roots.map((r) => fs.realpath(r).catch(() => null)))
  if (!hasSuffix(real) || !realRoots.some((r) => r !== null && within(r, real))) {
    throw new ApkError('invalid', `APK files must live inside ${roots.length === 1 ? 'your home directory' : 'an allowed folder'} and resolve to an .apk file.`, 'Copy the APK into your home folder (e.g. ~/Downloads) and pass that path.')
  }
  // O_NONBLOCK: opening a FIFO named x.apk must not wait for a writer; the handle's own stat then decides (no race).
  let handle: fs.FileHandle
  try {
    handle = await fs.open(real, fsc.O_RDONLY | (fsc.O_NONBLOCK ?? 0))
  } catch (err) {
    throw unreadable(file, err)
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new ApkError('invalid', `${file} is not a file.`, 'Pass the path of an .apk file.')
    return await inspectApk({
      size: stat.size,
      read: async (offset, length) => {
        if (offset < 0 || length < 0 || offset + length > stat.size) throw corrupt('a zip record points past the end of the file')
        const buf = Buffer.alloc(length)
        let bytesRead: number
        try {
          ;({ bytesRead } = await handle.read(buf, 0, length, offset))
        } catch (err) {
          throw unreadable(file, err)
        }
        if (bytesRead !== length) throw corrupt('the file changed or was cut short while being read')
        return buf
      }
    })
  } finally {
    await handle.close()
  }
}
