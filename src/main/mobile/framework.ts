/**
 * Roadmap M2 (first slice, M2a): which UI framework an Android app is built with, read offline from the names of
 * the files inside the .apk, and therefore how Nawi should read its screen. Electron-free and pure: the same entry
 * list always gives the same answer, so a profile or report built on it is stable from run to run.
 *
 * Only file names are used (no dex or native code is parsed): each framework ships files under fixed names that
 * an app cannot easily drop, e.g. the Flutter engine library or the React Native JavaScript bundle.
 */

export const APP_FRAMEWORKS = ['native', 'flutter', 'react_native', 'game_engine', 'webview'] as const
export type AppFramework = (typeof APP_FRAMEWORKS)[number]

/**
 * How the screen is read:
 * - `accessibility`: the Android accessibility tree (UI Automator), for apps drawn with Android views or Compose.
 * - `flutter_semantics`: Flutter's semantics tree, which Flutter publishes to Android accessibility once an
 *   accessibility client connects; the plain view tree only shows one opaque Flutter surface.
 * - `webview_cdp`: the DOM inside the app's WebView over the Chrome DevTools Protocol (needs WebView debugging).
 * - `screenshot`: no element tree at all (a game engine draws everything on one surface): screenshots only.
 */
export const READ_STRATEGIES = ['accessibility', 'flutter_semantics', 'webview_cdp', 'screenshot'] as const
export type ReadStrategy = (typeof READ_STRATEGIES)[number]

export interface FrameworkInfo {
  kind: AppFramework
  read_strategy: ReadStrategy
  /**
   * The markers that decided it: archive paths with the ABI folder of the first match (`lib/arm64-v8a/libflutter.so`)
   * or a folder (`assets/flutter_assets/`), never an arbitrary file name from the package. Empty for a native app.
   */
  evidence: string[]
  /** Other frameworks also found, outranked by `kind` (e.g. a React Native app that also ships a web bundle). */
  also: AppFramework[]
  /** One or two sentences: how Nawi reads this app's screen and what makes its locators reliable. */
  note: string
}

/** Android ABI folder names (lib/<abi>/): a fixed list, so evidence never echoes a made-up folder name. */
const ABI = '(?:arm64-v8a|armeabi-v7a|armeabi|x86|x86_64|riscv64|mips|mips64)'

interface Marker {
  re: RegExp
  /** What is reported: the matched path for a fixed file name, or the folder for "anything inside this folder". */
  folder?: string
}

interface Signal {
  /** Any of these decides the framework. */
  decisive: Marker[]
  /** Reported as evidence too, but not enough on their own (a generic name another stack could ship). */
  supporting: Marker[]
}

const so = (names: string): Marker => ({ re: new RegExp(`^lib/${ABI}/lib(?:${names})\\.so$`) })
const file = (path: string): Marker => ({ re: new RegExp(`^${path.replace(/[.]/g, '\\.')}$`) })
const folder = (path: string): Marker => ({ re: new RegExp(`^${path.replace(/[.]/g, '\\.')}.`), folder: path })

/**
 * In rank order: when two are present, the first decides. Flutter and React Native apps may embed web pages; a game
 * engine embedded in a native app (Unity as a library) still owns the screen while it runs.
 */
const SIGNALS: ReadonlyArray<[Exclude<AppFramework, 'native'>, Signal]> = [
  [
    'flutter',
    {
      // The engine, and the asset folder every Flutter build (debug or release) packages.
      decisive: [so('flutter'), folder('assets/flutter_assets/')],
      // The release AOT snapshot: a generic file name, only telling next to the engine.
      supporting: [so('app')]
    }
  ],
  [
    'react_native',
    {
      // The packaged JavaScript bundle, and the bridge library (merged into libreactnative.so on newer versions).
      decisive: [file('assets/index.android.bundle'), so('reactnativejni|reactnative')],
      // JavaScript engines React Native ships with, but others embed too.
      supporting: [so('hermes|hermesvm|hermestooling|jsc')]
    }
  ],
  [
    'game_engine',
    {
      // Unity, Godot and Unreal engine libraries.
      decisive: [so('unity'), so('godot_android'), so('UE4|Unreal')],
      supporting: [so('il2cpp'), so('main')]
    }
  ],
  [
    'webview',
    {
      // Cordova's runtime script, and Capacitor's config. A bare www/ or public/index.html is not enough: native
      // apps ship offline help or licence pages there too.
      decisive: [file('assets/www/cordova.js'), file('assets/capacitor.config.json')],
      supporting: [file('assets/www/index.html'), file('assets/public/index.html'), file('assets/capacitor.plugins.json')]
    }
  ]
]

function strategyFor(kind: AppFramework, debuggable: boolean): ReadStrategy {
  switch (kind) {
    case 'native':
    case 'react_native':
      return 'accessibility'
    case 'flutter':
      return 'flutter_semantics'
    case 'game_engine':
      return 'screenshot'
    case 'webview':
      // Debug builds of Cordova and Capacitor apps turn WebView debugging on; a release build only has it when the
      // app opts in, which can't be seen from the package, so the strategy that always works is the default.
      return debuggable ? 'webview_cdp' : 'accessibility'
  }
}

function noteFor(kind: AppFramework, debuggable: boolean): string {
  switch (kind) {
    case 'native':
      return 'Android views or Compose: Nawi reads the accessibility tree. Resource ids (android:id, or a Compose testTag with testTagsAsResourceId) and content descriptions make locators stable.'
    case 'flutter':
      return 'Flutter draws its own widgets, so Nawi reads its semantics tree (published to Android accessibility once Nawi connects). Widgets without a Semantics label or identifier show up unnamed: ask for them on key controls.'
    case 'react_native':
      return 'React Native renders Android views, so Nawi reads the accessibility tree. A testID is exposed as the view\'s resource id and accessibilityLabel as its description: set them on key controls.'
    case 'game_engine':
      return 'A game engine draws everything on one surface, so there is no element tree to read: Nawi can only work from screenshots (positions and images). Element-level locators need a test hook inside the game.'
    case 'webview':
      return debuggable
        ? 'The UI is web content in a WebView: Nawi reads its DOM over the DevTools protocol. Debug builds of Cordova and Capacitor apps turn WebView debugging on, which that needs.'
        : 'The UI is web content in a WebView. This is a release build, so Nawi reads the accessibility tree (WebViews expose their content there); for the DOM over DevTools, use a debug build or have the app call WebView.setWebContentsDebuggingEnabled(true).'
  }
}

/** Detects the framework from the archive's entry names; `debuggable` (from the manifest) picks the WebView strategy. */
export function detectFramework(entryNames: readonly string[], debuggable: boolean): FrameworkInfo {
  const markers = SIGNALS.flatMap(([, s]) => [...s.decisive, ...s.supporting])
  // One pass, keeping the smallest matching path per marker, so the answer doesn't depend on the order the zip
  // lists its entries in, and a folder with hundreds of files or an engine per ABI is reported once.
  const first = new Map<Marker, string>()
  for (const name of entryNames) {
    for (const m of markers) {
      if (!m.re.test(name)) continue
      const seen = first.get(m)
      if (seen === undefined || name < seen) first.set(m, name)
    }
  }
  const report = (ms: Marker[]): string[] => ms.flatMap((m) => (first.has(m) ? [m.folder ?? first.get(m)!] : []))
  const found: Array<{ kind: AppFramework; evidence: string[] }> = []
  for (const [kind, signal] of SIGNALS) {
    const decisive = report(signal.decisive)
    if (decisive.length > 0) found.push({ kind, evidence: [...decisive, ...report(signal.supporting)] })
  }
  const [top, ...rest] = found
  const kind = top?.kind ?? 'native'
  return {
    kind,
    read_strategy: strategyFor(kind, debuggable),
    evidence: top?.evidence ?? [],
    also: rest.map((f) => f.kind),
    note: noteFor(kind, debuggable)
  }
}
