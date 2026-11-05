import { createHash, randomBytes } from 'node:crypto'
import { constants as fsc, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { z } from 'zod'
import { within } from '../confine'
import { formatPath } from '../../shared/flow/yaml'
import { APP_FRAMEWORKS, READ_STRATEGIES } from './framework'

/**
 * Roadmap M1 (third slice, M1c): the mobile profile, `*.nawi.mobile.yaml`. `mobile_open` writes one after it has
 * installed and launched an app; passing the profile instead of the .apk next time reuses the same app, device,
 * permission list and launch activity, so a person (or a reviewed diff) can pin them. Versioned like flow files.
 * M2b adds two optional sections, so version 1 files from before still load: `screen` (the app's UI framework and how
 * its screen is read) and `device` (locale, dark mode, font scale and animations, set before every launch).
 *
 * Every name in it is later sent to the device inside an `adb shell` command line, so the schema only accepts the
 * characters Android itself allows in package, class and permission names; nothing here is ever shell syntax.
 */

export const PROFILE_SUFFIX = '.nawi.mobile.yaml'
/** A profile is a few hundred bytes; anything this large is not one. */
export const MAX_PROFILE_BYTES = 64 * 1024

/** Android package name: dot-separated segments that start with a letter (the manifest rule). */
export const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/
/** A fully qualified class (`$` for nested classes). */
export const CLASS_RE = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)+$/
/** A permission name (`android.permission.CAMERA`, `com.example.permission.X`). */
export const PERMISSION_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/
/** adb serial (`emulator-5554`, `R58M1234ABC`, `192.168.1.5:5555`) or AVD name (`Pixel_6_API_36`, `nawi-api36`). */
export const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
/** A BCP 47 language tag as Android's per-app locale takes it (`en-US`, `es-419`, `zh-Hans-CN`). */
export const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/

const DeviceShape = z
  .object({
    locale: z
      .string()
      .regex(LOCALE_RE, 'must be a language tag such as en-US')
      .nullable()
      .default(null)
      .describe("The app's own language (per-app locale, Android 13+); the rest of the device keeps its language."),
    dark_mode: z.boolean().nullable().default(null).describe('Dark theme on or off for the whole device (Android 10+).'),
    font_scale: z.number().min(0.5).max(3).nullable().default(null).describe('Font size multiplier for the whole device (1 is the default size).'),
    animations: z.boolean().nullable().default(null).describe('System animations; false turns them off so screens settle at once and runs are steadier.')
  })
  .strict()

/**
 * How the device is set up before launch (roadmap M2b). Null (or a field left out of the file): leave that setting as
 * the device has it.
 */
export type DeviceSettings = z.output<typeof DeviceShape>

/** Leave the device as it is. */
export const KEEP_DEVICE_SETTINGS: DeviceSettings = { locale: null, dark_mode: null, font_scale: null, animations: null }

/**
 * The settings a new profile starts with. A virtual device gets a fixed, test-friendly setup (English, light theme,
 * default font size, animations off) so every run sees the same screen, minus what its Android version can't set
 * (dark mode needs API 29, a per-app locale API 33; unknown API: all of them). A physical phone is somebody's own
 * device, so nothing on it is changed unless the profile is edited to ask for it.
 */
export function defaultDeviceSettings(kind: 'device' | 'avd', api: number | null = null): DeviceSettings {
  if (kind === 'device') return { ...KEEP_DEVICE_SETTINGS }
  const has = (min: number): boolean => api === null || api >= min
  return { locale: has(33) ? 'en-US' : null, dark_mode: has(29) ? false : null, font_scale: 1, animations: false }
}

const ProfileShape = z
  .object({
    version: z.literal(1),
    app: z
      .object({
        apk: z.string().min(1).max(4096).refine(isAbsolute, 'must be an absolute path').describe('The .apk this profile installs.'),
        package: z.string().max(255).regex(PACKAGE_RE, 'must be an Android package name such as com.example.app'),
        version_code: z.number().int().nonnegative().nullable(),
        version_name: z.string().max(200).nullable(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex digits').describe('Of the .apk when the profile was saved.')
      })
      .strict(),
    target: z
      .object({
        kind: z.enum(['device', 'avd']),
        name: z.string().regex(TARGET_RE, 'must be an adb serial or a virtual device (AVD) name')
      })
      .strict()
      .nullable()
      .describe('Where the app ran: a connected device (adb serial) or a virtual device (AVD) name. Null: the best one available.'),
    permissions: z
      .object({
        grant: z
          .array(z.string().max(255).regex(PERMISSION_RE, 'must be a permission name such as android.permission.CAMERA'))
          .max(200)
          .describe('Runtime permissions granted before launch (`pm grant`), so no dialog blocks a run.')
      })
      .strict(),
    launch: z
      .object({
        activity: z.string().max(500).regex(CLASS_RE, 'must be a fully qualified activity class').nullable()
      })
      .strict(),
    screen: z
      .object({
        framework: z.enum(APP_FRAMEWORKS),
        read: z.enum(READ_STRATEGIES)
      })
      .strict()
      .optional()
      .describe('The UI framework found in the .apk and how Nawi reads its screen (refreshed with the app facts).'),
    device: DeviceShape.optional().describe(
      'Device settings applied before launch. Missing (profiles saved before these settings existed): the device is left as it is.'
    )
  })
  .strict()

export type MobileProfile = z.infer<typeof ProfileShape>
export const MobileProfileSchema = ProfileShape

export interface ProfileError {
  path: string
  message: string
}

export type ParseProfileResult = { ok: true; profile: MobileProfile } | { ok: false; errors: ProfileError[] }

export function parseMobileProfile(text: string): ParseProfileResult {
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true })
  if (doc.errors.length > 0) return { ok: false, errors: doc.errors.slice(0, 20).map((e) => ({ path: '(root)', message: e.message.split('\n')[0] })) }
  let data: unknown
  try {
    // Aliases are refused (maxAliasCount 0 throws): a profile has no use for them, and they can blow up in size.
    data = doc.toJS({ maxAliasCount: 0 })
  } catch (err) {
    return { ok: false, errors: [{ path: '(root)', message: err instanceof Error ? err.message : String(err) }] }
  }
  const parsed = ProfileShape.safeParse(data)
  if (parsed.success) {
    const grant = parsed.data.permissions.grant
    if (new Set(grant).size !== grant.length) return { ok: false, errors: [{ path: 'permissions.grant', message: 'lists a permission twice' }] }
    return { ok: true, profile: parsed.data }
  }
  return {
    ok: false,
    errors: parsed.error.issues.slice(0, 20).map((i) => ({ path: formatPath(i.path.filter((p): p is string | number => typeof p !== 'symbol')), message: i.message }))
  }
}

export function stringifyMobileProfile(profile: MobileProfile): string {
  const doc = new Document(profile)
  doc.commentBefore = ' Nawi mobile profile: `nawi mobile-open <this file>` reinstalls and launches the app the same way.'
  return doc.toString({ lineWidth: 0 })
}

/** The published JSON Schema for editors (`# yaml-language-server: $schema=...`). */
export function mobileProfileJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://github.com/AlexanderVegazo26/nawi/blob/main/docs/schemas/mobile-profile.v1.schema.json',
    title: 'Nawi mobile profile (version 1)',
    ...(z.toJSONSchema(ProfileShape, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>)
  }
}

/** A profile file the user named that can't be used; `fix` is the one thing to do about it. */
export class ProfileFileError extends Error {
  constructor(
    readonly kind: 'not_found' | 'invalid',
    message: string,
    readonly fix: string
  ) {
    super(message)
  }
}

export const isProfilePath = (p: string): boolean => p.toLowerCase().endsWith(PROFILE_SUFFIX)

async function realRoots(roots: string[]): Promise<string[]> {
  return (await Promise.all(roots.map((r) => fs.realpath(r).catch(() => null)))).filter((r): r is string => r !== null)
}

/** Read and validate a profile inside one of `roots` (default: the home folder). */
export async function readProfileFile(file: string, roots: string[] = [homedir()]): Promise<MobileProfile> {
  if (!isAbsolute(file) || !isProfilePath(file)) {
    throw new ProfileFileError('invalid', `A mobile profile must be an absolute path ending in ${PROFILE_SUFFIX}.`, 'Pass the full path of the profile, or of the .apk.')
  }
  let real: string
  try {
    real = await fs.realpath(file)
  } catch {
    throw new ProfileFileError('not_found', `No file exists at ${file}.`, 'Check the path; the CLI resolves a relative path against the current folder.')
  }
  if (!isProfilePath(real) || !(await realRoots(roots)).some((r) => within(r, real))) {
    throw new ProfileFileError('invalid', `Mobile profiles must live inside your home directory and resolve to a ${PROFILE_SUFFIX} file.`, 'Move the profile into your home folder and pass that path.')
  }
  let text: string
  const handle = await fs.open(real, fsc.O_RDONLY | (fsc.O_NONBLOCK ?? 0)).catch(() => null)
  if (!handle) throw new ProfileFileError('invalid', `${file} can't be read.`, 'Check its permissions.')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new ProfileFileError('invalid', `${file} is not a file.`, `Pass a ${PROFILE_SUFFIX} file.`)
    if (stat.size > MAX_PROFILE_BYTES) throw new ProfileFileError('invalid', `${file} is larger than ${MAX_PROFILE_BYTES / 1024} KiB, so it is not a mobile profile.`, `Pass a ${PROFILE_SUFFIX} file.`)
    text = await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
  const parsed = parseMobileProfile(text)
  if (!parsed.ok) {
    const list = parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
    throw new ProfileFileError('invalid', `${file} is not a valid mobile profile: ${list}.`, 'Fix those fields, or open the .apk again to write a fresh profile.')
  }
  return parsed.profile
}

/** Where `mobile_open` saves a profile when none is named: next to the .apk, named after the package. */
export function defaultProfilePath(apkFile: string, pkg: string): string {
  return join(dirname(apkFile), `${pkg}${PROFILE_SUFFIX}`)
}

/**
 * Write a profile (temp file + rename) inside one of `roots`. Refuses a path that resolves outside them, a folder,
 * or an existing file that is not a profile (the suffix is checked on the real path, so a symlink can't redirect it).
 */
export async function writeProfileFile(file: string, profile: MobileProfile, roots: string[] = [homedir()]): Promise<string> {
  if (!isAbsolute(file) || !isProfilePath(file)) {
    throw new ProfileFileError('invalid', `A mobile profile must be saved to an absolute path ending in ${PROFILE_SUFFIX}.`, `Name the file like app${PROFILE_SUFFIX}.`)
  }
  const dir = await fs.realpath(dirname(file)).catch(() => null)
  if (dir === null) throw new ProfileFileError('not_found', `The folder ${dirname(file)} does not exist.`, 'Create it, or save the profile somewhere else.')
  let target = join(dir, basename(file))
  const existing = await fs.lstat(target).catch(() => null)
  if (existing?.isSymbolicLink()) target = await fs.realpath(target).catch(() => target)
  const stat = await fs.stat(target).catch(() => null)
  if (stat && !stat.isFile()) throw new ProfileFileError('invalid', `${file} is not a file.`, 'Save the profile under another name.')
  if (!isProfilePath(target) || !(await realRoots(roots)).some((r) => within(r, target))) {
    throw new ProfileFileError('invalid', `Mobile profiles are saved inside your home directory only, as ${PROFILE_SUFFIX} files.`, 'Pick a path inside your home folder.')
  }
  // Never save what readProfileFile would refuse (an over-long version name, an odd permission name...).
  const checked = ProfileShape.safeParse(profile)
  if (!checked.success) {
    const list = checked.error.issues.slice(0, 5).map((i) => `${formatPath(i.path.filter((p): p is string | number => typeof p !== 'symbol'))}: ${i.message}`).join('; ')
    throw new ProfileFileError('invalid', `The profile was not saved because it would not be valid: ${list}.`, 'Fix those values in a profile written by hand, or open the app with save_profile off.')
  }
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(4).toString('hex')}.tmp`)
  await fs.writeFile(tmp, stringifyMobileProfile(profile), { flag: 'wx', mode: 0o644 })
  try {
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
  return target
}

/** SHA-256 of a file, streamed (APKs can be hundreds of MB). */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer)
  } finally {
    await handle.close().catch(() => undefined)
  }
  return hash.digest('hex')
}
