# Nawi

A screen capture and recording studio — capture, record, annotate, edit, library, export.

Electron + React + TypeScript. Windows-first, but the codebase is cross-platform.

## Quick start

For contributors building from source. If you just want to *use* Nawi, go to
[Installing and first run](#installing-and-first-run).

```bash
npm install
npm run install-electron   # Electron (44+) fetches its binary separately
npm run dev
```

> **Note on `npm install`:** Since Electron 44, Electron no longer downloads its binary from a
> `postinstall` hook — `npm run install-electron` (which runs
> `node node_modules/electron/install.js`) does it, once.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the app with HMR against the Vite dev server |
| `npm run build` | Production build into `out/` |
| `npm run typecheck` | `tsc --noEmit` over both the node and web projects |
| `npm run typecheck:node` / `typecheck:web` | One project at a time |
| `npm run test:unit` | Vitest unit suite (no app launch, no DOM required) |
| `npm run test:agent` | Typecheck + unit suite, with a fix-ready report in `.test-report/summary.md` |
| `npm run test:e2e` | Builds, then runs Playwright against the real app |
| `npm run package` | Builds an unpacked app into `release/win-unpacked/` |
| `npm run dist` | Builds a distributable installer for the current platform |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Builds one platform's installers explicitly |

## Installers

| Platform | Artifacts | Architectures |
|---|---|---|
| Windows | NSIS installer (`.exe`) | x64, arm64 |
| macOS | `.dmg` + `.zip` | x64, arm64 |
| Linux | AppImage, `.deb`, `.rpm` | x64, arm64 (rpm x64 only) |

Every platform ships **separate x64 and arm64 builds** (except the Linux `.rpm`,
which is x64 only) — pick the one matching your hardware.

The macOS `.zip` is required, not optional: `electron-updater` looks the update
artifact up by its zip and auto-update is silently dead without one.

**electron-builder cannot cross-compile** — a macOS `.dmg` can only be produced
on macOS. `.github/workflows/release.yml` runs the three-OS matrix that actually
builds all of them; a local `npm run dist` only ever produces your own platform's.

**No build is code-signed yet.** What that means for you as a *user* is in
[Installing and first run](#installing-and-first-run), per platform. For a
maintainer: signing turns on by providing `CSC_LINK` / `CSC_KEY_PASSWORD`
(Windows) and `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` plus
`notarize: true` (macOS). No application icon is set either, so all three ship
the default Electron icon.

## Installing and first run

Audience: someone installing a released build and taking their first capture.
Contributors running from source want [Quick start](#quick-start) instead.

Two things behave differently on every platform, and both bite on first run:
**who grants screen-recording permission**, and **whether system audio can be
recorded at all**. Here is the whole matrix before the per-OS steps.

| | Windows | macOS | Linux |
|---|---|---|---|
| Per-app screen permission | None — the OS does not ask | Yes: TCC, granted in System Settings | Your desktop environment / portal |
| Relaunch after granting | No | **Yes** | No |
| System audio recorded | **Yes** (loopback) | No | No |
| Microphone | Prompted when you first record with it on | Prompted when you first record with it on | Prompted when you first record with it on |

> **If a capture fails, you get the recovery card — on every platform, and for a
> screenshot or a recording alike.** That is the panel naming the exact settings
> path, with a button that opens it, a re-check button, and a *What went wrong*
> line quoting the underlying error verbatim. It is raised by a capture that
> actually failed, not by a permission status, so it is reachable on Windows
> (where the OS reports screen access as `granted` unconditionally) and on a
> first-ever macOS attempt (where the OS has not been asked yet).
>
> Two honest caveats. If Nawi cannot even *read* the permission status, there is
> no settings path to put on a card and you get a transient error message
> instead — rare, but it is the one path with no card. And a failed *recording*
> raises the card **and** a transient message, while a failed *screenshot*
> raises one or the other; that difference is cosmetic, not a difference in what
> you can do about it.
>
> Because the card quotes the real error, a failure that is not about permission
> at all — no supported video encoder, a lost source, no disk — says so on the
> card rather than being dressed up as a permission problem. Read that line
> before you go looking for a toggle.
>
> **How far this is verified:** by reading the code and by unit tests over the
> per-platform card copy, plus one end-to-end assertion that pins what Windows
> reports. CI runs the E2E suite on both ubuntu and Windows runners, so that
> assertion is a merge gate.
> Nobody has exercised this flow on a real macOS or Linux machine — the macOS
> and Linux wording below is verified as *copy*, not as observed behaviour.

> **Known defect: the card is titled "Aperture", not "Nawi."** It reads *"Aperture
> needs screen recording access"* (on Windows, *"Aperture couldn't read your
> screen"*). This is the right card for Nawi, not another application. Aperture is
> the project codename, and the card's copy is transcribed verbatim from a
> normative specification block that was never renamed — so the fix belongs in the
> spec first, and the test that asserts the string is faithfully pinning the spec
> rather than encoding a typo.

### Windows

1. Pick the NSIS installer (`.exe`) for your architecture — **arm64** for
   Windows-on-ARM, **x64** otherwise — and run it. **SmartScreen will warn you**,
   because the build is not code-signed. Choose **More info → Run anyway**.
2. Launch Nawi and take a screenshot. **Windows has no per-app screen-capture
   permission**, so there is nothing to grant and nothing to relaunch for.
3. Record. **System audio is captured on Windows and only on Windows** — Nawi
   asks the OS for the loopback device. The *Record system audio* track is on by
   default.
4. Microphone and webcam are prompted **when you press Record with that track
   ticked** — not when you tick it, and never at startup. Denying either leaves
   the screen recording running; the HUD shows that track as failed.

**If a capture fails anyway**, that is not a permission problem, because Windows
has none to give. The real causes are a display driver, a remote/RDP session, or
workplace group policy — and Nawi's recovery card names exactly those, since a
failed capture is what raises it here rather than a permission status. Its
**Open System Settings** button lands on **Settings → Privacy & security**: the
closest honest destination, since Windows exposes no screen-capture privacy
page, and there is no relaunch prompt because the macOS grant-then-relaunch
state does not exist on Windows. The card's *What went wrong* line is the useful
part on this platform — it quotes the actual error, which is what tells driver
apart from policy.

### macOS

1. Open the `.dmg` and drag Nawi to Applications. Pick the build matching your
   hardware: **arm64** for Apple Silicon, **x64** for Intel.
2. **Gatekeeper will block it.** The build is neither signed nor notarized, so a
   *downloaded* copy is quarantined and macOS reports *"Nawi is damaged and
   can't be opened"* (exact wording varies by macOS version). It is not damaged.
   Clear the quarantine flag:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Nawi.app
   ```
   Building and running locally never reproduces this, because quarantine is
   applied only to downloads.
3. Launch Nawi and **take a screenshot** (Capture region / full screen). This is
   what triggers macOS's screen-recording request — Nawi deliberately does not
   ask at install or at launch.
4. Grant it in **System Settings → Privacy & Security → Screen & System Audio
   Recording**, then switch **Nawi** on. The recovery card's **Open System
   Settings** button deep-links straight to that pane.
5. **Relaunch Nawi.** macOS reads the grant at process start, so it does not take
   effect in the already-running instance. The card carries a **Relaunch now**
   button next to the note *"Already granted it? macOS sometimes needs … to
   relaunch before it takes effect."*
   Be aware of what that button is and is not: it appears on **every** macOS
   permission card, because Nawi flags the possibility from the platform alone.
   It does **not** detect that you specifically are in the
   granted-but-not-relaunched state. If capture still fails after you have
   granted access, relaunch — the app will not work it out for you.
6. Record. **System audio is not captured on macOS.** The *Record system audio*
   track is on by default, so a default recording shows that track in an error
   state reading *"System audio is not available on this platform."* That is
   expected, not a fault: the video and any microphone track record normally.
   Untick the track to keep the HUD clean.
7. Microphone and webcam are prompted **when you press Record with that track
   ticked** — one at a time, and never together. Denying either leaves the screen
   recording running.

### Linux

1. Install the package for your distribution — `.AppImage` (x64/arm64), `.deb`
   (Debian/Ubuntu, x64/arm64), or `.rpm` (Fedora/RHEL, **x64 only**). An
   AppImage must be marked executable before it will run:
   ```bash
   chmod +x Nawi-*.AppImage && ./Nawi-*.AppImage
   ```
2. Screen capture goes through **your desktop environment's screen-sharing
   settings**, not an app-level permission — that is the wording Nawi itself
   uses, because it has no way to name your particular desktop's settings app.
   (Whether your compositor prompts via a portal on first capture is a property
   of your desktop environment, not of Nawi, and is not something this repo can
   confirm for you.)
3. If a capture fails, the recovery card points at those settings — but its
   **Open System Settings** button cannot work on Linux and will tell you it
   could not open settings. That is by design, not a crash; open them yourself.
4. Record. **System audio is not captured on Linux**, and the default-on *Record
   system audio* track shows *"System audio is not available on this platform."*
   — same as macOS, and equally expected. Microphone and webcam are prompted when
   you press Record with that track ticked.

### Putting the `nawi` CLI on your PATH

Nawi ships a `nawi` command-line front end, but **the installers deliberately do
not modify your system PATH** — an installer mutating machine-wide PATH leaves
residue behind on uninstall. Two ways to get it:

- `npm install -g .` from a clone of this repo, or
- point your shell at the copy inside the installed app. It is unpacked from the
  asar precisely so plain `node` can run it:
  - Windows — `<install dir>\resources\app.asar.unpacked\out\cli\index.js`
  - macOS — `/Applications/Nawi.app/Contents/Resources/app.asar.unpacked/out/cli/index.js`
  - Linux — `<install dir>/resources/app.asar.unpacked/out/cli/index.js`

What the CLI can do is in [Agent access](#agent-access--mcp-and-cli).

## Agent access — MCP and CLI

Nawi exposes sixteen tools over a loopback JSON-RPC endpoint: `capture_screen`,
`capture_region`, `capture_element`, `start_recording`, `stop_recording`,
`get_capture`, `get_state_layer` (CLI: `nawi state --capture_id <id>`), `list_captures`, `search_captures`, `annotate`,
`redact`, `export_guide`, `export_flow` (CLI: `nawi export-flow --capture_id <id>`)
`run_flow` (CLI: `nawi run <file> [--headless] [--var name=value] [--screenshots all|failed|off] [--junit report.xml]`),
`list_runs` (CLI: `nawi runs [--limit 20] [--status failed]`) and `get_run` (CLI: `nawi run-info --run_id <id>`). Every tool has a CLI command (a test keeps the
two lists equal); `nawi tools [--json]` prints what the running app offers with each tool's JSON Schema, and
`nawi runs --follow [--interval ms]` streams runs saved from now on as NDJSON (one run per line) until interrupted.
Exit codes: 0 success, 1 the app reported an error or a flow step failed, 2 usage, 3 Nawi not running.
A refused tool call is JSON-RPC -32000 with a typed code in `error.data.code` (`NOT_FOUND`, `INVALID_ARGUMENTS` with
`data.issues`, `AGENT_ACCESS_PAUSED`, ...); each `tools/list` entry names the codes that tool can return under
`_meta["nawi/errors"]`, and [docs/MCP-ERRORS.md](docs/MCP-ERRORS.md) documents the shape and every code (a contract
test drives every tool through it and keeps the page in step with the code). The MCP server, its dispatch layer, the state
projection and the revision model live in `src/main/mcp/`; `src/mcp/stdio-bridge.ts`
is the stdio front end an MCP client connects to.

Long calls report progress and can be cancelled. An MCP client that sends `_meta.progressToken` with
`tools/call` (and accepts `text/event-stream`, as the Streamable-HTTP transport does) gets one
`notifications/progress` message per settled flow step (`step 3/7 save (click): passed`: ids and actions only,
never values), then the answer. `notifications/cancelled` stops the call it names after the step in progress.
Cancels by id are scoped to the `Mcp-Session-Id` the client got from `initialize`, so one client cannot stop
another's call; a caller without a session (the CLI, a plain HTTP request) cancels by closing its request. The
stdio bridge passes progress through and handles a cancel itself, at once: it drops the request if it is still
queued, or closes the request it sent. Code: `src/main/mcp/progress.ts`, `src/mcp/forward.ts`.

Saved runs are also MCP resources, so a client can read them without a tool call: `resources/list` names the
record and HTML report of the 50 newest runs, `resources/templates/list` gives the patterns
`nawi://runs/{run_id}/run.json`, `report.html`, `junit.xml` and `{+screenshot}` (a step's `screenshot` or
`shots.before`/`shots.after` path from run.json, returned as base64), and `resources/read` returns one file
(up to 8 MiB). A URI that isn't one of those is JSON-RPC -32602, a run or file that doesn't exist -32002; both
carry Nawi's typed code in `error.data.code`, like tool errors. Only files a run writer makes are reachable
(links out of the run's own folder are refused), the token and the agent kill switch apply as for tools (templates
stay listable while paused, like `tools/list`), and each list or read goes to the same call log.
Code: `src/main/mcp/resources.ts`.

Two common jobs are MCP prompts, which a client can offer as ready-made requests (`prompts/list`, `prompts/get`):
`run_and_triage` (argument `file`, an absolute `*.nawi.yaml` path) runs the flow with `run_flow` and, when a step
fails, has the model read the run record and screenshots and call it an app bug, locator bug, flake or environment
problem, with the evidence and a minimal repro. `heal_flow` (argument `run_id`) has it check that a failed step's
locator no longer finds its element and propose the smallest change to the flow as a diff, without writing or running
anything (checking the fix is left to you). A prompt only returns message text: it reads and runs nothing itself, so
it works while agent access is paused, and the tool calls the model makes afterwards are checked as usual. Every
argument is checked before it goes into the text: a run id must be a run id; a file must be an absolute `*.nawi.yaml`
path on one line with no invisible or direction-changing characters, and goes in only as a quoted JSON string that
the text calls a path. A path can still contain words, so only pass paths you trust. An unknown prompt or a bad
argument is JSON-RPC -32602 with `data.code` `NOT_FOUND` or `INVALID_ARGUMENTS`. Code: `src/main/mcp/prompts.ts`.

`nawi` is a command-line front end to the **same** endpoint, with the same
bearer token and the same tools, so every rule the app enforces — the agent kill
switch, redaction gating, path confinement — applies unchanged.

```bash
nawi list
nawi capture --name "Login screen"
nawi capture-region --x 0 --y 0 --width 800 --height 600
nawi search --query invoice --json
```

Commands are a thin naming layer over the tools: `capture`, `capture-region`,
`capture-element`, `record`, `record-stop`, `get`, `list`, `search`, `annotate`,
`redact`, `export`.

Flag values are JSON-coerced, so `--width 800` sends a number while
`--name "Login screen"` sends a string. Exit codes are the scripting contract:
`0` success, `1` the app reported an error, `2` usage error, `3` Nawi is
not running.

It **will not start the app for you** — a shell command silently opening a GUI
is a surprise nobody consented to. That refusal is inherited from the MCP bridge.

The one explicit way to start it from a shell is **`nawi serve`**: it runs the
engine headless, as a local daemon, with no window and no global hotkeys, and the
other commands and MCP clients attach to it as they would to the app. It stays
in the foreground, prints one `nawi serve: ready on <url> (pid <n>, ...)` line
once the endpoint is up (never the token), and Ctrl-C or SIGTERM stops it with
exit 0 and removes its `mcp.json`. `--user-data-dir <dir>` runs it on a separate
profile (point other commands at it with `NAWI_MCP_CONFIG=<dir>/mcp.json`). It
exits 3 if Nawi is already running on that profile or the endpoint cannot start:
one Nawi runs per profile, and opening the app a second time (also while
`nawi serve` runs) shows the running instance's window instead of starting
another. On Windows a stop is a hard kill, so the `mcp.json` stays until the next
start replaces it.
On Linux with no display it uses Chromium's headless backend, so flows run on a
server or in CI without xvfb (`nawi run --headless`); screen capture and
recording still need a desktop session.

```bash
nawi serve --user-data-dir /tmp/nawi-ci &
export NAWI_MCP_CONFIG=/tmp/nawi-ci/mcp.json
until nawi tools >/dev/null 2>&1; do sleep 0.2; done   # exit 3 until the endpoint is up
nawi run login.nawi.yaml --headless --junit report.xml
kill %1   # SIGTERM: clean stop
```

The installers do **not** put `nawi` on your `PATH` — see
[Putting the `nawi` CLI on your PATH](#putting-the-nawi-cli-on-your-path) for the
shipped binary's location on each platform and why the installer leaves PATH
alone.

## What works today

- **Capture** — full screen, a specific window (with a thumbnail picker), or a
  dragged region.
- **Region select** — a *freeze-frame* overlay: every display is captured first,
  then an opaque overlay per display renders that frozen bitmap. There is no
  hide-then-capture race and no transparent-window compositing to fight.
- **Recording** — `getDisplayMedia` + `MediaRecorder`, with the source chosen by
  the app's own picker rather than the OS one. Optional system audio, microphone
  and webcam tracks, each permission-prompted independently and at the moment it
  is actually needed. A floating HUD controls the take.
- **Recording writes MP4 by default.** `MediaRecorder` on this Electron build
  accepts `video/mp4;codecs=avc1.42E01E,mp4a.40.2` and emits a real ISO-BMFF file
  at roughly 40% the size of the equivalent VP9 WebM — no ffmpeg, no WebCodecs, no
  native modules. The WebM fallback chain remains, because MP4 support is version-
  and platform-dependent. See `src/shared/recording.ts`, which probes rather than
  assumes.
- **Annotation editor** — arrow, rectangle, ellipse, text, highlighter,
  blur/pixelate, step numbers, and crop, with undo/redo, zoom, and a colour and
  stroke palette. Fully keyboard-driven. **Stills only** — see Known gaps.
- **Library** — a searchable grid, rename, delete-with-confirm, and reopening any
  capture back into the editor.
- **Export** — PNG/JPEG with annotations flattened, copy-to-clipboard, or save the
  original asset untouched. **Stills only** — see Known gaps.
- **Flow file format** (`*.nawi.yaml`, version 1) — the editable, versionable
  form of a recorded process: a target (browser URL or desktop app), `vars`, and
  steps (`click`, `fill`, `press`, `select`, `hover`, `scroll`, `navigate`,
  `wait`, `assert`, `screenshot`), each target carrying several ranked locators
  plus an optional box and reference crop. `src/shared/flow` parses and
  validates it (unknown keys, duplicate step ids and unresolved `${vars.*}` are
  errors reported as `file:line:col path: message`), writes it back with the
  author's comments kept, and publishes a JSON Schema at
  [`docs/schemas/flow.v1.schema.json`](docs/schemas/flow.v1.schema.json) for
  editor validation (`# yaml-language-server: $schema=...`). Secrets are
  referenced as `${secret.name}`, never stored. Example:
  `src/shared/flow/__fixtures__/create-invoice.nawi.yaml`.
- **Recording → flow** (`export_flow` over MCP, `nawi export-flow` on the CLI) —
  turns a capture's harvested input events into flow YAML: clicks, one `fill`
  per field with its final value (`select` for a `<select>`), named keys such as
  Enter, each with its ranked selectors. Fields marked secret at capture become
  `${secret.<name>}` placeholders (their values were never recorded). Scrolls,
  resizes, modifier and editing keys, the click that only focused a field, and
  what was entered in fields a flow can't fill (file pickers, sliders, color
  pickers) are left out and counted in the reply, with warnings to review. It returns the
  YAML and writes nothing. Converter: `src/shared/flow/from-recording.ts`.
- **Flow replay engine** (`src/main/replay`) — runs a flow in a Chromium page
  over raw CDP. Each step's locators are tried in order: the first one matching
  exactly one element wins (one matching several is ambiguous and skipped). It
  waits for the element to be visible, enabled and not covered, up to the step's
  `timeout_ms` (default 5 s), then acts with real input events (click, hover,
  fill, select by value or label, key chords such as `Control+a`, scroll,
  navigate, wait, screenshot). Date/time inputs are filled by setting their
  value, and a value in the wrong format fails the step. A `wait` with a target
  waits up to its `ms`. `assert` checks visible/enabled, text
  (whitespace-normalised, contains) and the exact URL. JavaScript dialogs are
  dismissed and recorded on the step. `${env.*}` and
  `${secret.*}` are resolved before the first step, and a missing one stops the
  run before anything happens. Each step gets a result: status, timing, which
  locator matched and what the earlier ones found, and a reason when it fails.
  Typed values are never put in the result, and secret values are scrubbed from
  messages (also when percent-encoded or whitespace-folded). The first failure stops the run. Only the top document is searched
  (no iframes or shadow roots yet).
- **Running a flow** (`run_flow` over MCP, `nawi run` on the CLI) — replays a
  `*.nawi.yaml` file (absolute path inside your home directory, at most 1 MiB;
  other files are refused before they are read) in a fresh browser with a
  throwaway profile, headed unless `--headless`, or in a new tab of a browser
  already listening for DevTools on this machine (`--cdp-endpoint 9222`; only
  loopback addresses, and the tab is closed afterwards). `--var name=value`
  overrides a declared var. `${env.NAME}` comes from the shell that ran
  `nawi run` and `${secret.name}` from `NAWI_SECRET_<name>`: the CLI sends only
  the names the flow file (or a `--var` value) mentions, and the app never
  passes its own environment to a flow. Missing inputs fail the run before a
  browser starts. It prints one line per step and exits 0 when every step
  passed, 1 otherwise (`--json` for the full report). Pausing agent access,
  pressing Ctrl-C on `nawi run`, or an MCP `notifications/cancelled`, stops a run after the step in progress.
  Code: `src/main/flow-run.ts`, `src/cli/run.ts`.
- **Run records** — every run, passed or failed (also one that stopped before a
  browser started), is saved in the app's data folder as `runs/<run-id>/`:
  `run.json` (format version 1: the flow's name, path and SHA-256, start time,
  duration, status, per step the status, start time, duration, the locator that
  matched and the ones that missed, the error and any dialogs, the page URL
  after the step, the console errors it caused (`console.error`, uncaught
  exceptions, browser errors) and the requests it sent that failed (HTTP 400+
  or no response; cancelled ones are left out), at most 20 of each per step
  with a count of the rest (a run waits up to half a second after its last
  step for the requests that step sent); the same for opening the target, the
  final URL;
  the app, OS and browser versions and the page's viewport), `junit.xml` (one
  test case per step, for CI test reporters; console errors and failed
  requests go in the failure text, or `<system-err>` for a passing step), `steps/NNN-<step-id>.png` for each
  `screenshot` step, and the page around each step as JPEG: by default the
  page before the first step and after every step (`steps/NNN-<step-id>.before.jpg`
  / `.after.jpg`, listed under the step's `shots`; a step's "before" is the
  previous step's "after" and an identical image is stored once).
  `--screenshots failed` (MCP `screenshots: "failed"`) keeps only the page the
  failing step left, `off` none; `nawi run` prints the failing step's
  screenshot path and JUnit names it in the failure text. The folder is written under a temporary name and renamed,
  so a reader never sees half a run; the newest 200 runs are kept. Secret
  values are scrubbed from the text, and in every screenshot the fields the
  run typed a secret into are drawn as discs (masked just for the capture,
  then restored); a secret the page itself shows elsewhere as text is not
  masked. URLs are also stripped of credentials and
  token-, session- and signature-like parameters. `nawi run` prints up to three
  console errors and failed requests under each step, and `run_flow`'s answer
  carries the first three of each (the record has up to 20). `run_flow` answers with `run_id` and
  `run_dir`; `nawi run` prints `record: <folder>`, and `--junit <file>` copies
  the JUnit XML there (an old report at that path is removed first, so a run
  that cannot start never leaves a stale result for CI). Each run folder also
  has `report.html`: the same result as one self-contained page for a person
  (status, totals, a link to the first failure, per step the locators, error,
  page evidence and the before/after screenshots embedded as data URIs; no
  script, no network, a Content-Security-Policy that allows only inline style
  and data images, all text escaped), so it can be attached to a ticket or CI
  run as is. `list_runs` / `get_run` (CLI `nawi runs`, `nawi run-info`) let an
  agent browse the saved records: newest first, filter by status or flow file,
  one record in full by run id. Code: `src/main/run-record.ts`,
  `src/main/run-report.ts`.
- **Model access layer for AI features** (`src/main/llm`): the one interface
  that semantic assertions, healing, triage and exploration will use. Backends:
  Anthropic (official SDK), any OpenAI-compatible `/chat/completions` endpoint
  (hosted or a local server), and an in-process stub for tests. Off by default:
  `settings.ai.provider` is `none` and the model id is always configuration
  (`settings.ai.model`), never built in. `settings.ai.baseUrl` is the
  OpenAI-compatible server's address only (http/https, no credentials or
  query); the Anthropic backend never sends there (a proxy for it is set with
  the SDK's `ANTHROPIC_BASE_URL`, and the log shows it). The environment can
  choose too (`NAWI_LLM_PROVIDER`, `NAWI_LLM_MODEL`, `NAWI_LLM_BASE_URL`); keys come only
  from the environment (`NAWI_LLM_API_KEY`, `OPENAI_API_KEY` for
  OpenAI-compatible, or the Anthropic SDK's own credentials), never from the
  settings file. Every call is redacted first (the run's secrets, the built-in
  key/token/card/email/phone patterns and the workspace redaction rules; images
  are sent as is), answered from a response cache keyed by the redacted input
  when it was asked before (on any backend, so a flow replays with the same
  verdicts against a stub, a local or a hosted model), capped per run (calls,
  tokens including a high estimate of the input, and cost when
  `inputUsdPerMTok`/`outputUsdPerMTok` are set; no automatic retries), and
  logged to `<userData>/ai/outbound.jsonl` before it is sent (exactly what left
  the machine, images as sha256 + size; if the line can't be written, nothing is
  sent). Offline mode (`settings.ai.offline`, or `NAWI_LLM_OFFLINE=1`, which can
  only turn it on) makes no network call; cached answers still count. Anything
  without an answer comes back as "not evaluated" with a reason (`offline`,
  `no_provider`, `no_model`, `budget`, `refused`, `cancelled`, `error`), never
  as a pass; refused, cut-off and empty answers are never cached, and a workspace
  redaction rule that doesn't compile stops the call. No feature calls it yet, and there is no settings UI for it yet.

## Keyboard shortcuts

Global (work while the app is unfocused):

| Action | Shortcut |
|---|---|
| Capture region | `Ctrl+Shift+1` |
| Capture full screen | `Ctrl+Shift+2` |
| Capture window | `Ctrl+Shift+3` |
| Start recording | `Ctrl+Shift+4` |
| Stop recording | `Ctrl+Shift+S` |
| Show main window | `Ctrl+Shift+0` |

In the editor: `A R E T H B N C V` select a tool, `1`–`8` pick a colour, `[`/`]`
adjust stroke, `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `Ctrl+S` save, `Ctrl+C` copy,
`Ctrl+Shift+E` export, `Ctrl+0/+/−` zoom.

> Export is `Ctrl+Shift+E`, not `Ctrl+Shift+S`: a global hotkey is intercepted
> before the focused window ever sees it, so binding Export to the same chord as
> global stop-recording would make Export unreachable at all times.

## Architecture

Two documents written before implementation, and still the reference:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process split, IPC contract,
  capture pipeline, security posture, storage layout, annotation model.
- [`docs/UX-SPEC.md`](docs/UX-SPEC.md) — flows, every required screen state,
  accessibility requirements as checkable values, and the shortcut map.

> ARCHITECTURE.md §2.3 (and its assumption #4) still says MP4 would require
> bundling ffmpeg and that the app therefore records WebM only. That note is
> **superseded, not edited** — see `src/shared/recording.ts` for the probe that
> disproves it.

The shape worth knowing up front:

- **Stills never touch a media stream.** `desktopCapturer.getSources` with
  `thumbnailSize` set to the display's full pixel size *is* the screenshot. All of
  it happens in the main process.
- **DIP vs. physical pixels** is the single most bug-prone part of the app. The
  `screen` module speaks DIP; bitmaps are physical pixels. Every conversion goes
  through `dipRectToPixels` in `src/main/capture.ts` — don't inline that maths
  anywhere else.
- **All recorded audio goes through one Web Audio graph.** `MediaRecorder` encodes
  a single audio track; handing it a stream with both a loopback track and a
  microphone track silently drops one of them, with nothing reporting a problem.
  Mixing to one `MediaStreamAudioDestinationNode` is what makes both audible — and
  it is also why the tracks cannot be separated again after the fact.
- **Assets are served over a custom `capture://` scheme**, not `file://`.
  Cross-origin `fetch()` to a custom scheme is blocked from a `file://` page, so
  the renderer reads assets via `<img>`/`<video>` and anything needing bytes goes
  through IPC instead.

## Security posture

Every `BrowserWindow` runs with `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false` and `webSecurity: true`. The preload exposes named
methods only — never `ipcRenderer`, and no generic `invoke(channel, …)` escape
hatch. Library ids are validated against a UUID pattern and resolved through the
index rather than being used as path segments. An E2E test asserts that
`require`, `process` and `ipcRenderer` are all unreachable from the renderer.

`docs/SECURITY-REVIEW-M1A.md` records the standing review.

## Testing

```bash
npm run test:unit    # vitest
npm run test:agent   # typecheck + vitest, writes .test-report/ (what CI's verify job runs)
npm run test:e2e     # builds, then drives the real Electron app
```

`npm run test:agent` writes `.test-report/summary.md`: every type error with
`file:line:col`, and every failing test with `file:line`, its source line, the
expected/received diff and a command that reruns only that test, plus
`results.json`, `junit.xml`, `failures.json` and `run.log`. Exit 0 means
everything ran and passed, 1 that something failed, 3 that nothing failed but a
test was skipped (for example the browser suites with no Playwright Chromium
installed) or a step was left out. `-- <files>` narrows the Vitest run,
`-- --no-typecheck` skips the typecheck.

64 Playwright tests across six specs drive the actual built app:

| Spec | Covers |
|---|---|
| `app.spec.ts` | Window rendering, the preload security boundary, library empty states, the capture pipeline end to end (desktopCapturer → PNG → disk → index → `capture://` → `<img>`), delete-with-confirm |
| `annotation.spec.ts` | Drawing and persisting shapes, undo/redo, tool and palette bindings |
| `recording.spec.ts` | The record lifecycle and track selection |
| `conformance.spec.ts` | UX-SPEC conformance over required screen states |
| `mcp.spec.ts` | The sixteen tools over the loopback endpoint, redaction gating, the agent kill switch |
| `cli.spec.ts` | The `nawi` binary's exit-code contract, including its refusal to launch the app |

Unit tests live beside their subjects (`*.test.ts`) and cover the pure layers —
container selection, the sidecar/library store, redaction gating, HAR harvest,
CDP selectors and the MCP projection/revision model.

## Known gaps

- **Flows can be written, exported and run (CLI/MCP), but not yet edited in
  the UI.** Run records have an HTML report and MCP/CLI listing, but no in-app UI to browse them yet. Secrets come from
  `NAWI_SECRET_*` only (no OS keychain or prompt yet).
  The app's own recordings don't run the CDP state harvest yet
  (`src/main/harvest` is built and tested but not wired into a capture path), so
  `export_flow` only has input events to work with on captures whose sidecar
  carries them (for example DC-4 sidecars written by another tool). Wiring the
  harvest into browser recordings, run records and the flow editor land as
  separate slices.
- **Video is playback-only in the editor.** `isVideo` gates off annotate, crop,
  copy and export (`src/renderer/components/EditorView.tsx:922-1146`), so a
  recording cannot be trimmed, shortened or re-exported without leaving the app.
  Work on a video export pipeline — trim, format/resolution/bitrate control,
  animated GIF, speed change — is **in progress and not yet merged**; see
  [`docs/BACKLOG-video.md`](docs/BACKLOG-video.md) for the queue and
  `docs/DRAFT-video-export-VEX.md` for the requirements.
- Video captures show a placeholder tile in the library rather than a poster frame.
- System-audio capture (`audio: 'loopback'`) is Windows-only. Elsewhere the
  recording continues video-only, and because the track is enabled by default the
  user sees it in an error state ("System audio is not available on this
  platform") on every default macOS/Linux recording.
- The UX-PRM.2 recovery card is raised by any failed capture whose
  permission-status *read* succeeds. If that read itself fails there is no
  platform and no settings path to render, so the failure falls back to a
  transient message with no card. Narrow, but it is the remaining hole.
- The macOS relaunch hint is a platform constant, not a detection: every macOS
  user with a failed capture is told a relaunch may be needed, whether or not
  they are actually in the granted-but-not-relaunched state.
- The renderer→main round trip that carries a recorder-origin failure back to
  the recovery card is not covered by any test for a *duplicated* start; the
  race window is one IPC round trip. Untested, not known-broken.
- The recovery card is titled "Aperture", the project codename. The copy is
  transcribed verbatim from a normative spec block that was never renamed.
- Mic and system audio are mixed down to a single track at record time, so they
  cannot be separated, muted independently or re-balanced afterwards.
- The library is a flat JSON index. That's correct at this scale and keeps the app
  free of native modules; it is not intended to scale to six figures of captures.
