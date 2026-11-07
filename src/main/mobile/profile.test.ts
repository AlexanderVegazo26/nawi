import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultProfilePath,
  mobileProfileJsonSchema,
  parseMobileProfile,
  ProfileFileError,
  readProfileFile,
  sha256File,
  stringifyMobileProfile,
  writeProfileFile,
  type MobileProfile
} from './profile'

/**
 * The mobile profile (`*.nawi.mobile.yaml`, roadmap M1c): round trip, what the schema refuses (every name ends up in
 * an adb shell line on the device), and that reading/writing stays inside the allowed folder. Temp folders only.
 */

const ROOT = join(__dirname, '..', '..', '..')
const SCHEMA_FILE = join(ROOT, 'docs', 'schemas', 'mobile-profile.v1.schema.json')

let root: string
let home: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nawi-profile-'))
  home = join(root, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const profile = (over: Partial<MobileProfile> = {}): MobileProfile => ({
  version: 1,
  app: { apk: '/home/u/app.apk', package: 'dev.nawi.sample', version_code: 3, version_name: '1.2', sha256: 'a'.repeat(64) },
  target: { kind: 'avd', name: 'Pixel_API_36' },
  permissions: { grant: ['android.permission.CAMERA'] },
  launch: { activity: 'dev.nawi.sample.MainActivity' },
  ...over
})

describe('mobile profile format', () => {
  it('the committed JSON Schema matches the model (regenerate: WRITE_PROFILE_SCHEMA=1 npx vitest run src/main/mobile/profile.test.ts)', () => {
    const generated = JSON.stringify(mobileProfileJsonSchema(), null, 2) + '\n'
    if (process.env.WRITE_PROFILE_SCHEMA === '1') writeFileSync(SCHEMA_FILE, generated)
    expect(readFileSync(SCHEMA_FILE, 'utf8'), `${SCHEMA_FILE} is stale`).toBe(generated)
  })

  it('round-trips through YAML, with a comment saying how to use it', () => {
    const text = stringifyMobileProfile(profile())
    expect(text.startsWith('# Nawi mobile profile'), text).toBe(true)
    expect(parseMobileProfile(text)).toEqual({ ok: true, profile: profile() })
    const anyDevice = profile({ target: null, launch: { activity: null } })
    expect(parseMobileProfile(stringifyMobileProfile(anyDevice))).toEqual({ ok: true, profile: anyDevice })
  })

  it.each([
    ['a shell command in a permission', { permissions: { grant: ["android.permission.X'; reboot; '"] } }, 'permissions.grant[0]'],
    ['a shell command in the activity', { launch: { activity: 'a.B$(reboot)' } }, 'launch.activity'],
    ['a flag as the target', { target: { kind: 'device', name: '-s' } }, 'target.name'],
    ['a relative apk path', { app: { ...profile().app, apk: 'app.apk' } }, 'app.apk'],
    ['a bad hash', { app: { ...profile().app, sha256: 'XYZ' } }, 'app.sha256'],
    ['an unknown key', { extra: 1 } as Partial<MobileProfile>, '(root)'],
    ['a permission listed twice', { permissions: { grant: ['android.permission.CAMERA', 'android.permission.CAMERA'] } }, 'permissions.grant'],
    ['an onboarding tap with an empty locator', { onboarding: [{ when: 'intro', tap: {} }] }, 'onboarding[0].tap'],
    ['an onboarding tap past a sign-in form', { onboarding: [{ when: 'login_wall', tap: { text: 'Sign in' } }] } as unknown as Partial<MobileProfile>, 'onboarding[0].when'],
    ['a locator with a newline', { onboarding: [{ when: 'intro', tap: { text: 'Skip\nreboot' } }] }, 'onboarding[0].tap.text'],
    ['a locator field Nawi does not match on', { onboarding: [{ when: 'intro', tap: { class: 'Button' } }] } as unknown as Partial<MobileProfile>, 'onboarding[0].tap'],
    ['more than 20 onboarding taps', { onboarding: Array.from({ length: 21 }, (_, i) => ({ when: 'intro' as const, tap: { text: `Next ${i}` } })) }, 'onboarding'],
    ['a password written into the profile', { sign_in: { fields: [{ field: { text: 'Password' }, value: 'hunter2' }], submit: { text: 'Sign in' } } }, 'sign_in.fields[0].value'],
    ['a value with text around the reference', { sign_in: { fields: [{ field: { text: 'Email' }, value: 'qa+${env.RUN}@example.test' }], submit: { text: 'Sign in' } } }, 'sign_in.fields[0].value'],
    ['a vars reference (profiles have no vars)', { sign_in: { fields: [{ field: { text: 'Email' }, value: '${vars.email}' }], submit: { text: 'Sign in' } } }, 'sign_in.fields[0].value'],
    ['a sign-in without fields', { sign_in: { fields: [], submit: { text: 'Sign in' } } }, 'sign_in.fields'],
    ['a sign-in without a submit button', { sign_in: { fields: [{ field: { text: 'Email' }, value: '${env.E}' }] } } as unknown as Partial<MobileProfile>, 'sign_in.submit'],
    ['an empty submit locator', { sign_in: { fields: [{ field: { text: 'Email' }, value: '${env.E}' }], submit: {} } }, 'sign_in.submit']
  ])('refuses %s, naming the field', (_what, over, path) => {
    const r = parseMobileProfile(stringifyMobileProfile({ ...profile(), ...over } as MobileProfile))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.path), JSON.stringify(r.errors)).toContain(path)
  })

  it('round-trips the onboarding taps in order, and still loads a profile without them', () => {
    const taps = profile({
      onboarding: [
        { when: 'intro', tap: { resource_id: 'com.android.camera2:id/confirm_button' } },
        { when: 'permission_dialog', tap: { resource_id: 'com.android.permissioncontroller:id/permission_allow_foreground_only_button' } },
        { when: 'consent', tap: { text: 'Accept "all" cookies', content_desc: 'Accept' } }
      ]
    })
    expect(parseMobileProfile(stringifyMobileProfile(taps))).toEqual({ ok: true, profile: taps })
    const r = parseMobileProfile(stringifyMobileProfile(profile()))
    expect(r.ok && r.profile.onboarding, 'no onboarding section: nothing to replay').toBeUndefined()
  })

  it('round-trips a sign_in section of references, and still loads a profile without one', () => {
    const signIn = profile({
      sign_in: {
        fields: [
          { field: { resource_id: 'dev.nawi.sample:id/email' }, value: '${env.TEST_EMAIL}' },
          { field: { resource_id: 'dev.nawi.sample:id/password' }, value: '${secret.app_pw}' }
        ],
        submit: { text: 'Sign in' }
      }
    })
    const text = stringifyMobileProfile(signIn)
    expect(parseMobileProfile(text)).toEqual({ ok: true, profile: signIn })
    const r = parseMobileProfile(stringifyMobileProfile(profile()))
    expect(r.ok && r.profile.sign_in, 'no sign_in section: no sign-in').toBeUndefined()
  })

  it('refuses YAML aliases and duplicate keys', () => {
    expect(parseMobileProfile('version: 1\nversion: 1\n').ok).toBe(false)
    const r = parseMobileProfile('x: &a [1]\ny: *a\n')
    expect(r.ok).toBe(false)
  })

  it('defaultProfilePath puts it next to the apk, named after the package', () => {
    expect(defaultProfilePath('/home/u/dl/app-debug.apk', 'dev.nawi.sample')).toBe('/home/u/dl/dev.nawi.sample.nawi.mobile.yaml')
  })
})

describe('profile files', () => {
  it('writes inside the allowed folder and reads it back; overwriting keeps one file', async () => {
    const file = join(home, 'app.nawi.mobile.yaml')
    expect(await writeProfileFile(file, profile(), [home])).toBe(file)
    expect(await writeProfileFile(file, profile({ target: null }), [home])).toBe(file)
    expect(await readProfileFile(file, [home])).toEqual(profile({ target: null }))
    expect(readFileSync(file, 'utf8')).not.toMatch(/\.tmp/)
  })

  it.each([
    ['outside the allowed folder', () => join(root, 'x.nawi.mobile.yaml'), /inside your home directory/],
    ['without the suffix', () => join(home, 'x.yaml'), /ending in \.nawi\.mobile\.yaml/],
    ['a relative path', () => 'x.nawi.mobile.yaml', /absolute path/],
    ['in a folder that does not exist', () => join(home, 'nope', 'x.nawi.mobile.yaml'), /does not exist/]
  ])('refuses to write %s', async (_what, path, message) => {
    await expect(writeProfileFile(path(), profile(), [home])).rejects.toThrow(message)
  })

  it('refuses to save a profile it could not read back (a value the schema refuses)', async () => {
    const file = join(home, 'app.nawi.mobile.yaml')
    const long = profile({ app: { ...profile().app, version_name: 'v'.repeat(300) } })
    await expect(writeProfileFile(file, long, [home])).rejects.toThrow(/would not be valid: app\.version_name/)
    expect(() => readFileSync(file), 'nothing written').toThrow()
  })

  it('refuses to write through a symlink that leads out of the folder or onto a non-profile file', async () => {
    const victim = join(root, 'victim.txt')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, join(home, 'evil.nawi.mobile.yaml'))
    await expect(writeProfileFile(join(home, 'evil.nawi.mobile.yaml'), profile(), [home])).rejects.toBeInstanceOf(ProfileFileError)
    expect(readFileSync(victim, 'utf8'), 'the link target is untouched').toBe('keep')
  })

  it('reading names the problem and the fix', async () => {
    await expect(readProfileFile(join(home, 'missing.nawi.mobile.yaml'), [home])).rejects.toMatchObject({ kind: 'not_found' })
    const bad = join(home, 'bad.nawi.mobile.yaml')
    writeFileSync(bad, 'version: 2\n')
    await expect(readProfileFile(bad, [home])).rejects.toThrow(/version: .*app: /)
    const big = join(home, 'big.nawi.mobile.yaml')
    writeFileSync(big, `# ${'x'.repeat(70_000)}\n`)
    await expect(readProfileFile(big, [home])).rejects.toThrow(/larger than 64 KiB/)
    const outside = join(root, 'o.nawi.mobile.yaml')
    writeFileSync(outside, stringifyMobileProfile(profile()))
    await expect(readProfileFile(outside, [home])).rejects.toThrow(/inside your home directory/)
  })

  it('gives a path outside the allowed folder the same refusal whether or not anything is there (no existence oracle)', async () => {
    const existing = join(root, 'there.nawi.mobile.yaml')
    writeFileSync(existing, stringifyMobileProfile(profile()))
    const paths = [existing, join(root, 'missing.nawi.mobile.yaml'), join(root, 'no-such-dir', 'x.nawi.mobile.yaml')]
    const answer = (err: unknown): string =>
      err instanceof ProfileFileError ? `${err.kind}: ${err.message}` : `not a ProfileFileError: ${String(err)}`
    const reads = await Promise.all(paths.map((p) => readProfileFile(p, [home]).then(() => 'read', answer)))
    expect(new Set(reads).size, `read answers for existing / missing file / missing folder: ${JSON.stringify(reads)}`).toBe(1)
    expect(reads[0]).toMatch(/^invalid: Mobile profiles must live inside your home directory/)
    const writes = await Promise.all(paths.slice(1).map((p) => writeProfileFile(p, profile(), [home]).then(() => 'written', answer)))
    expect(new Set(writes).size, `write answers for a missing file / missing folder: ${JSON.stringify(writes)}`).toBe(1)
    expect(writes[0]).toMatch(/^invalid: Mobile profiles are saved inside your home directory only/)
  })

  it('sha256File hashes the bytes', async () => {
    const f = join(home, 'a.bin')
    writeFileSync(f, 'abc')
    expect(await sha256File(f)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
