import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_MANIFEST_BYTES, MAX_URIS_PER_FILTER, describeManifest, inspectApk, inspectApkFile, resolveClassName, type ApkInfo } from './apk'
import { parseAxml, type AxmlElement } from './axml'
import { ApkError } from './errors'
import { makeZip } from './fixtures/make-zip'
import { bufferSource, readCentralDirectory, readEntry } from './zip'

/** Built by fixtures/build-fixture.sh with aapt2 from fixtures/sample/AndroidManifest.xml. */
const SAMPLE_PATH = resolve(__dirname, 'fixtures/sample.apk')
const SAMPLE = new Uint8Array(readFileSync(SAMPLE_PATH))

const SAMPLE_INFO: ApkInfo = {
  package: 'dev.nawi.sample',
  version_code: 42,
  version_name: '1.4.2',
  min_sdk: 26,
  target_sdk: 35,
  launcher_activity: 'dev.nawi.sample.MainActivity',
  abis: ['arm64-v8a', 'x86_64'],
  debuggable: true,
  permissions: [
    { name: 'android.permission.INTERNET', runtime: false, max_sdk: null },
    { name: 'android.permission.CAMERA', runtime: true, max_sdk: null },
    { name: 'android.permission.POST_NOTIFICATIONS', runtime: true, max_sdk: null },
    { name: 'android.permission.ACCESS_FINE_LOCATION', runtime: true, max_sdk: 32 },
    { name: 'dev.nawi.sample.permission.C2D', runtime: false, max_sdk: null },
    { name: 'android.permission.READ_CONTACTS', runtime: true, max_sdk: null }
  ],
  deep_links: [
    { component: 'dev.nawi.sample.links.LinkActivity', uri: 'https://sample.nawi.dev/invite*', auto_verify: true },
    { component: 'dev.nawi.sample.links.LinkActivity', uri: 'nawisample://open', auto_verify: false }
  ],
  exported_components: [
    { kind: 'activity', name: 'dev.nawi.sample.MainActivity', why: 'explicit' },
    { kind: 'activity', name: 'dev.nawi.sample.links.LinkActivity', why: 'explicit' },
    { kind: 'service', name: 'dev.nawi.sample.sync.SyncService', why: 'explicit' },
    { kind: 'receiver', name: 'dev.nawi.sample.BootReceiver', why: 'explicit' }
  ],
  // fixtures/sample.apk ships placeholder libsample.so files and assets/readme.txt: no framework's marker files.
  framework: {
    kind: 'native',
    read_strategy: 'accessibility',
    evidence: [],
    also: [],
    note: 'Android views or Compose: Nawi reads the accessibility tree. Resource ids (android:id, or a Compose testTag with testTagsAsResourceId) and content descriptions make locators stable.'
  },
  unresolved: []
}

async function sampleManifestBytes(): Promise<Uint8Array> {
  const src = bufferSource(SAMPLE)
  const entry = (await readCentralDirectory(src)).find((e) => e.name === 'AndroidManifest.xml')!
  return new Uint8Array(await readEntry(src, entry, MAX_MANIFEST_BYTES))
}

async function apkErrorOf(p: Promise<unknown>): Promise<ApkError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(err, 'expected the call to fail with an ApkError').toBeInstanceOf(ApkError)
  return err as ApkError
}

/** Same-length junk over every occurrence of `word` (UTF-8 and UTF-16LE), so the pool's offsets stay valid. */
function scrub(bytes: Uint8Array, word: string): number {
  let hits = 0
  for (const enc of [Buffer.from(word, 'utf8'), Buffer.from(word, 'utf16le')]) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let at = buf.indexOf(enc); at >= 0; at = buf.indexOf(enc, at + enc.length)) {
      const junk = enc.length === word.length ? Buffer.alloc(enc.length, 'q') : Buffer.from('q'.repeat(word.length), 'utf16le')
      junk.copy(buf, at)
      hits++
    }
  }
  return hits
}

describe('inspectApk on an APK built by aapt2', () => {
  it('reports package, versions, SDKs, launcher, ABIs, debuggable, permissions, deep links and exported components', async () => {
    expect(await inspectApk(bufferSource(SAMPLE)), 'fixtures/sample.apk vs fixtures/sample/AndroidManifest.xml').toEqual(SAMPLE_INFO)
  })

  it('reads a manifest whose attribute names were stripped (shrunk release builds) through the resource ids', async () => {
    const bytes = await sampleManifestBytes()
    const names = ['versionCode', 'versionName', 'minSdkVersion', 'targetSdkVersion', 'maxSdkVersion', 'debuggable', 'exported', 'autoVerify', 'scheme', 'pathPrefix', 'host', 'name']
    for (const n of names) expect(scrub(bytes, n), `attribute name "${n}" should be in the fixture's string pool`).toBeGreaterThan(0)
    const tree = parseAxml(bytes)
    const left = JSON.stringify(tree).match(/"name":"(versionCode|minSdkVersion|exported|debuggable)"/)
    expect(left, 'scrubbing should leave no readable attribute name behind').toBeNull()
    const entries = (await readCentralDirectory(bufferSource(SAMPLE))).map((e) => e.name)
    expect(describeManifest(tree, entries), 'stripped-name manifest should read the same as the original').toEqual(SAMPLE_INFO)
  })
})

describe('inspectApk failures give one specific fix', () => {
  it('refuses an Android App Bundle with the bundletool command to convert it', async () => {
    const aab = makeZip([{ name: 'BundleConfig.pb', data: new Uint8Array([1]) }, { name: 'base/manifest/AndroidManifest.xml', data: new Uint8Array([2]) }])
    const err = await apkErrorOf(inspectApk(bufferSource(aab)))
    expect(err.kind).toBe('unsupported')
    expect(err.fix).toMatch(/bundletool build-apks --bundle app\.aab .*--mode=universal/)
  })

  it('refuses a zip without a manifest as "not an Android app"', async () => {
    const err = await apkErrorOf(inspectApk(bufferSource(makeZip([{ name: 'readme.txt', data: Buffer.from('hi') }]))))
    expect(err.kind).toBe('invalid')
    expect(err.message).toMatch(/no AndroidManifest\.xml/)
  })

  it('refuses a file that is not a zip, and a download cut short, with the re-download fix', async () => {
    for (const [what, bytes] of [
      ['random bytes', new Uint8Array(4096).fill(7)],
      ['first half of sample.apk', SAMPLE.subarray(0, SAMPLE.length >> 1)],
      ['empty file', new Uint8Array()]
    ] as const) {
      const err = await apkErrorOf(inspectApk(bufferSource(bytes)))
      expect(err.kind, what).toBe('invalid')
      expect(err.fix, what).toMatch(/Download or build the APK again/)
    }
  })

  it('refuses a manifest that claims more than the size cap before inflating it (zip bomb)', async () => {
    const bomb = makeZip([{ name: 'AndroidManifest.xml', data: new Uint8Array(64), deflate: true, declaredSize: MAX_MANIFEST_BYTES + 1 }])
    const err = await apkErrorOf(inspectApk(bufferSource(bomb)))
    expect(err.message).toMatch(/over the 4194304-byte limit/)
  })

  it('refuses a manifest that inflates past the cap even when its declared size lies', async () => {
    const bomb = makeZip([{ name: 'AndroidManifest.xml', data: new Uint8Array(MAX_MANIFEST_BYTES + 1024), deflate: true, declaredSize: 100 }])
    const err = await apkErrorOf(inspectApk(bufferSource(bomb)))
    expect(err.message).toMatch(/does not decompress/)
  })

  it('refuses an entry whose compressed size is over the cap before allocating it, whatever its declared size', async () => {
    const zip = makeZip([{ name: 'AndroidManifest.xml', data: new Uint8Array(8), declaredSize: 8 }])
    // Patch the central directory's compressed size (offset 20 of the record) to 1.5 GB.
    const cd = Buffer.from(zip.buffer).indexOf(Buffer.from('504b0102', 'hex'))
    Buffer.from(zip.buffer).writeUInt32LE(1_500_000_000, cd + 20)
    const err = await apkErrorOf(inspectApk(bufferSource(zip)))
    expect(err.message).toMatch(/claims 1500000000 compressed bytes, over the limit/)
  })

  it('refuses a stored entry whose two sizes differ (it would return bytes past the cap)', async () => {
    const zip = makeZip([{ name: 'AndroidManifest.xml', data: new Uint8Array(64), declaredSize: 8 }])
    const err = await apkErrorOf(inspectApk(bufferSource(zip)))
    expect(err.message).toMatch(/stored uncompressed but its two sizes differ/)
  })

  it('refuses an entry that keeps its sizes in a zip64 extra field as zip64, not as corrupt', async () => {
    const err = await apkErrorOf(inspectApk(bufferSource(makeZip([{ name: 'AndroidManifest.xml', data: new Uint8Array(8), declaredSize: 0xffffffff }]))))
    expect(err.kind).toBe('unsupported')
    expect(err.fix).toMatch(/without zip64/)
  })

  it('refuses an encrypted manifest entry', async () => {
    const err = await apkErrorOf(inspectApk(bufferSource(makeZip([{ name: 'AndroidManifest.xml', data: new Uint8Array(8), flags: 1 }]))))
    expect(err.kind).toBe('unsupported')
    expect(err.message).toMatch(/encrypted/)
  })

  it('refuses a plain-text AndroidManifest.xml (a source tree zipped up, not a build)', async () => {
    const err = await apkErrorOf(inspectApk(bufferSource(makeZip([{ name: 'AndroidManifest.xml', data: Buffer.from('<manifest package="a"/>') }]))))
    expect(err.message).toMatch(/not compiled Android XML/)
  })

  it('throws only ApkError, never a RangeError or TypeError, for any corruption of the manifest or the archive', async () => {
    const manifest = await sampleManifestBytes()
    const mutate = (base: Uint8Array) =>
      fc.array(fc.tuple(fc.nat(base.length - 1), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 12 }).map((edits) => {
        const copy = new Uint8Array(base)
        for (const [at, value] of edits) copy[at] = value
        return copy
      })
    fc.assert(
      fc.property(mutate(manifest), (bytes) => {
        try {
          describeManifest(parseAxml(bytes), [])
        } catch (e) {
          if (!(e instanceof ApkError)) throw new Error(`parseAxml/describeManifest threw ${String(e)} instead of an ApkError`)
        }
      }),
      { seed: 20261104, numRuns: 400 }
    )
    await fc.assert(
      fc.asyncProperty(mutate(SAMPLE), async (bytes) => {
        try {
          await inspectApk(bufferSource(bytes))
        } catch (e) {
          if (!(e instanceof ApkError)) throw new Error(`inspectApk threw ${String(e)} instead of an ApkError`)
        }
      }),
      { seed: 20261104, numRuns: 300 }
    )
  })
})

describe('describeManifest rules', () => {
  const el = (name: string, attrs: Record<string, string | number | boolean> = {}, children: AxmlElement[] = []): AxmlElement => ({
    name,
    attributes: Object.entries(attrs).map(([k, value]) =>
      k === 'package' ? { ns: '', name: k, resId: null, value } : { ns: 'http://schemas.android.com/apk/res/android', name: k, resId: null, value }
    ),
    children
  })
  const filter = (actions: string[], categories: string[], data: Record<string, string>[] = [], attrs: Record<string, boolean> = {}) =>
    el('intent-filter', attrs, [
      ...actions.map((a) => el('action', { name: `android.intent.action.${a}` })),
      ...categories.map((c) => el('category', { name: `android.intent.category.${c}` })),
      ...data.map((d) => el('data', d))
    ])
  const manifest = (components: AxmlElement[], extra: AxmlElement[] = []) => el('manifest', { package: 'com.example' }, [...extra, el('application', {}, components)])

  it('resolves class names relative to the package', () => {
    expect(resolveClassName('.Main', 'com.example')).toBe('com.example.Main')
    expect(resolveClassName('Main', 'com.example')).toBe('com.example.Main')
    expect(resolveClassName('org.other.Main', 'com.example')).toBe('org.other.Main')
  })

  it('defaults min and target SDK to 1 when there is no <uses-sdk>, and reports no launcher for a launcher-less app', () => {
    const info = describeManifest(manifest([]), [])
    expect([info.min_sdk, info.target_sdk, info.launcher_activity, info.debuggable]).toEqual([1, 1, null, false])
  })

  it('takes a launcher activity-alias, skipping a disabled one, and counts an enabled one with an intent filter but no android:exported as exported', () => {
    const info = describeManifest(
      manifest([
        el('activity-alias', { name: '.Off', enabled: false }, [filter(['MAIN'], ['LAUNCHER'])]),
        el('activity-alias', { name: '.On', targetActivity: '.Main' }, [filter(['MAIN'], ['LAUNCHER'])]),
        el('activity', { name: '.Main' })
      ]),
      []
    )
    expect(info.launcher_activity).toBe('com.example.On')
    expect(info.exported_components, 'the disabled alias never runs, so it is not listed').toEqual([{ kind: 'activity-alias', name: 'com.example.On', why: 'intent-filter' }])
  })

  it('combines every scheme, host (with port) and path of one intent filter, and needs BROWSABLE for a deep link', () => {
    const info = describeManifest(
      manifest([
        el('activity', { name: '.Links', exported: true }, [
          filter(['VIEW'], ['BROWSABLE', 'DEFAULT'], [{ scheme: 'https' }, { scheme: 'http' }, { host: 'a.test', port: '8443' }, { path: 'x' }, { pathPattern: '/p/.*' }]),
          filter(['VIEW'], ['DEFAULT'], [{ scheme: 'internal', host: 'only' }])
        ])
      ]),
      []
    )
    expect(info.deep_links.map((d) => d.uri)).toEqual(['https://a.test:8443/x', 'https://a.test:8443/p/.*', 'http://a.test:8443/x', 'http://a.test:8443/p/.*'])
  })

  it('shows a pathPattern such as .* after a slash, so it cannot read as part of the host', () => {
    const info = describeManifest(manifest([el('activity', { name: '.L', exported: true }, [filter(['VIEW'], ['BROWSABLE'], [{ scheme: 'https', host: 'example.com', pathPattern: '.*' }])])]), [])
    expect(info.deep_links.map((d) => d.uri)).toEqual(['https://example.com/.*'])
  })

  it('stops at MAX_URIS_PER_FILTER without building the whole schemes x hosts x paths product', () => {
    const data = Array.from({ length: 3000 }, (_, i) => ({ scheme: `s${i}`, host: `h${i}.test`, path: `/p${i}` }))
    const started = performance.now()
    const info = describeManifest(manifest([el('activity', { name: '.L', exported: true }, [filter(['VIEW'], ['BROWSABLE'], data)])]), [])
    expect(info.deep_links).toHaveLength(MAX_URIS_PER_FILTER)
    // 3000^3 URIs would take hours; the early stop takes well under a second even on a slow runner.
    expect(performance.now() - started, 'describeManifest time in ms').toBeLessThan(2000)
  })

  it('leaves out disabled components entirely: not exported, not a launcher', () => {
    const info = describeManifest(
      manifest([el('receiver', { name: '.Boot', exported: true, enabled: false }), el('activity', { name: '.Main', enabled: false }, [filter(['MAIN'], ['LAUNCHER'])])]),
      []
    )
    expect([info.exported_components, info.launcher_activity]).toEqual([[], null])
  })

  it('reports resource-referenced values as unresolved instead of printing the raw id, and drops a link it cannot complete', () => {
    const ref = '@0x7f120034'
    const root = manifest([
      el('activity', { name: '.L', exported: true }, [
        filter(['VIEW'], ['BROWSABLE'], [{ scheme: 'https', host: ref }]),
        filter(['VIEW'], ['BROWSABLE'], [{ scheme: 'app', host: 'open' }])
      ])
    ])
    root.attributes.push({ ns: 'http://schemas.android.com/apk/res/android', name: 'versionName', resId: null, value: '@0x7f120001' })
    const info = describeManifest(root, [])
    expect(info.version_name).toBeNull()
    expect(info.deep_links.map((d) => d.uri), 'the https filter has an unresolved host').toEqual(['app://open'])
    expect(info.unresolved).toEqual(['deep link host of com.example.L (@0x7f120034)', 'versionName (@0x7f120001)'])
  })

  it('lists ABIs from lib/<abi>/*.so only, sorted and unique', () => {
    const info = describeManifest(manifest([]), ['lib/x86/a.so', 'lib/armeabi-v7a/b.so', 'lib/x86/c.so', 'lib/readme.txt', 'assets/lib/x/d.so'])
    expect(info.abis).toEqual(['armeabi-v7a', 'x86'])
  })

  it('keeps the first of a permission requested twice', () => {
    const info = describeManifest(
      manifest([], [el('uses-permission', { name: 'android.permission.CAMERA', maxSdkVersion: 28 }), el('uses-permission-sdk-23', { name: 'android.permission.CAMERA' })]),
      []
    )
    expect(info.permissions).toEqual([{ name: 'android.permission.CAMERA', runtime: true, max_sdk: 28 }])
  })
})

describe('inspectApkFile confines paths like flow files', () => {
  const home = mkdtempSync(join(tmpdir(), 'nawi-apk-home-'))
  const outside = mkdtempSync(join(tmpdir(), 'nawi-apk-out-'))
  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  writeFileSync(join(home, 'app.apk'), SAMPLE)
  writeFileSync(join(outside, 'secret.apk'), SAMPLE)
  writeFileSync(join(home, 'notes.txt'), 'x')
  symlinkSync(join(outside, 'secret.apk'), join(home, 'link.apk'))
  symlinkSync(join(home, 'notes.txt'), join(home, 'notes.apk'))
  mkdirSync(join(home, 'folder.apk'))

  it('refuses a FIFO named .apk without blocking on it', async (ctx) => {
    if (process.platform === 'win32') ctx.skip()
    const fifo = join(home, 'pipe.apk')
    execFileSync('mkfifo', [fifo])
    const err = await apkErrorOf(inspectApkFile(fifo, [home]))
    expect(err.message).toMatch(/is not a file/)
  })

  it('says a file it may not read is unreadable (with the permission fix), not missing', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) ctx.skip()
    const locked = join(home, 'locked.apk')
    writeFileSync(locked, SAMPLE)
    chmodSync(locked, 0o000)
    const err = await apkErrorOf(inspectApkFile(locked, [home]))
    chmodSync(locked, 0o600)
    expect([err.kind, err.message]).toEqual(['invalid', `Nawi cannot read ${locked} (EACCES). Check that your user can read the file and its folders (e.g. \`chmod u+r\` on the file).`])
  })

  it('gives a path outside the root the same refusal whether or not anything is there (no existence oracle)', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) ctx.skip()
    const locked = join(outside, 'locked.apk')
    writeFileSync(locked, SAMPLE)
    chmodSync(locked, 0o000)
    const paths = [join(outside, 'secret.apk'), join(outside, 'missing.apk'), join(outside, 'no-such-dir', 'x.apk'), locked]
    const answers = await Promise.all(paths.map(async (p) => {
      const err = await apkErrorOf(inspectApkFile(p, [home]))
      return `${err.kind}: ${err.message.replace(p, '<path>')}`
    }))
    chmodSync(locked, 0o600)
    expect(new Set(answers).size, `answers for existing / missing / missing folder / unreadable outside the root: ${JSON.stringify(answers)}`).toBe(1)
    expect(answers[0]).toMatch(/^invalid: APK files must live inside/)
  })

  it('reads an APK inside the allowed root', async () => {
    expect((await inspectApkFile(join(home, 'app.apk'), [home])).package).toBe('dev.nawi.sample')
  })

  it.each([
    ['a relative path', 'app.apk', 'invalid', /must be absolute/],
    ['a file that is not .apk', '/notes.txt', 'invalid', /Only Android packages/],
    ['a missing file', '/missing.apk', 'not_found', /No file exists/],
    ['a symlink out of the root', '/link.apk', 'invalid', /inside an allowed folder|inside your home/],
    ['an .apk symlink to a non-apk file', '/notes.apk', 'invalid', /resolve to an \.apk/],
    ['a folder named .apk', '/folder.apk', 'invalid', /is not a file/]
  ])('refuses %s', async (_what, path, kind, message) => {
    const err = await apkErrorOf(inspectApkFile(path.startsWith('/') ? join(home, path) : path, [home]))
    expect(err.kind, `${path}: ${err.message}`).toBe(kind)
    expect(err.message).toMatch(message)
  })
})
