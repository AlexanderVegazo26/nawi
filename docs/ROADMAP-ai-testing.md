# Roadmap — Nawi as an AI-era testing tool

> Status: planned. Each slice below is sized for one change with tests; none is built yet unless it says so.
> Where a slice maps to an existing flow-core item it says so (F5, F6, F4c, L1, A-series).

## Goal

Nawi already records a browser session, turns it into a flow (`export_flow`), replays it deterministically
(`run_flow`, `nawi run`) and stores a run record with JUnit XML and before/after screenshots. The goal of this
roadmap is to make that loop the most useful one for people **and** AI agents:

1. Tests that **survive UI change** instead of failing on every renamed selector.
2. **Assertions** that need no hand-written selectors (visual, network, semantic).
3. Flows that an agent can **author, run and triage** through MCP.
4. **Determinism and flake control** so a green run means something.
5. A place in **CI** that reviewers actually read.
6. **Fully drivable from outside**: every capability reachable by CLI and by MCP, with an LLM provider layer and
   ready-made integrations for agent harnesses, so Nawi is a tool other systems call, not only an app.
7. **Mobile that configures itself**: drop an app file in, and Nawi opens what it needs, studies the app and
   suggests how to test it (Track M below).
8. **Built on the real engines**: browser DevTools data for web recording, k6 for load, and each mobile platform's
   native test libraries for execution (Track E below).

## Principles

- **Replay stays deterministic.** A model may help author a flow or propose a repair, but a replay never depends on
  a live model call. Model verdicts are cached against the exact inputs (flow revision, screenshot hash) and a
  missing verdict is reported as "not evaluated", never as a pass.
- **No silent rewriting.** Healing produces a reviewable YAML diff. Nothing edits a flow without a person (or an
  explicit agent grant) accepting it.
- **Local-first, secrets out.** Flows and run records never hold secrets; the redaction gate and secret masking
  already in `src/main/harvest` and the screenshot capture apply to every new artifact.
- **Small, stable MCP surface.** New tools are added only when an agent needs them, with schemas and tests.

## Slices (build order)

Order: F4c (HTML report) → AI11 → AI12 → AI13 → M1 → M2 → M3 → AI1 + F6 → M5 → DT1 → AI2 + F5 → AI3 → AI5 → AI4 → M4 → MN1 → AI9 → LT1 → AI14 → M6 → M7 → AI6 → AI7 → AI8 → M8 → M9 → AI10.

### AI1 — Intent and layered locators
- Step field `intent` (one plain-language sentence: what the step is for), optional and additive to `version: 1`.
- Locator layers per step: role + name, visible text, test id, CSS, and a visual anchor (the reference crop).
  Record all of them; the replayer already tries them in ranked order.
- Report which layer matched for each step in the run record so drift is visible before a step fails.
- Done when: schema + round-trip tests, `export_flow` fills `intent` from the recorded note or a generated
  placeholder, the run record shows the matched layer.

### F6 (existing) — Healing proposals
- When the primary locator fails but a lower layer or a vision match succeeds, produce a YAML patch (the proposal),
  with the evidence (before/after crops, the DOM around the match) attached to the run record.
- When nothing matches, use `intent` + the accessibility snapshot to suggest a candidate and mark it unverified.
- MCP: `get_heal_proposals(run_id)` and `apply_heal(run_id, step_id)`; CLI `nawi heal <run>` prints the diff.
- Done when: a fixture app with a renamed button heals to a correct proposal, and a wrong match is rejected by the
  replay of the proposed flow.

### AI2 + F5 (existing) — Visual assertions
- `assert: { visual: { baseline: step | file, tolerance, mask: [regions] } }` using the F4b2 before/after shots as
  the baseline source; pixel diff with a per-region tolerance and ignore masks (clocks, avatars, ads).
- The diff image is stored in the run record and shown in the HTML report.
- Baseline update is an explicit command (`nawi baseline accept <run>`), reviewed like a code change.
- Done when: a one-pixel anti-aliasing change passes, a moved button fails with a readable diff, masks work.

### AI3 — Network assertions
- `assert: { request: { url, method, status, json_shape, max_ms } }` evaluated on the HAR already captured by
  `harvest/har.ts` (redacted).
- Budget assertions on navigation timing (start with load and the slowest request).
- Done when: a failed API call fails the step with the request in the evidence, and a slow call fails a budget.

### AI5 — Flake and determinism tooling
- `nawi run --repeat N` reports a pass rate and which steps flaked; the run record stores the flake rate.
- Tag a flow `quarantine` when its rate drops below a threshold; quarantined flows run but do not fail a suite.
- Control sources of nondeterminism: clock (extend `cdp/clock.ts`), `Math.random`, animations off, network
  record/replay mocks for third-party calls.
- Done when: a deliberately racy fixture is flagged with a flake rate, and the same flow with mocks is stable over
  N runs.

### AI4 — Semantic assertions (model-judged, cached)
- `assert: { ai: "the cart shows 2 items" }` evaluated against the screenshot and accessibility snapshot.
- Verdict, rationale and the model id are stored in the run record and cached by (flow revision, screenshot hash,
  statement). Replays use the cache; with no cache and no model the step is reported "not evaluated".
- Gated by a per-run consent flag and the agent kill switch; the screenshot sent has secrets masked.
- Done when: cached verdicts replay offline and identically, and an uncached run without a model never reports pass.

### AI9 — CI integration
- Sharded parallel runs for headless browser flows (`nawi test --shard i/n`), JUnit and the self-contained HTML
  report (F4c).
- A GitHub Action that runs a suite and comments the failing steps with their diff images on the pull request.
- Done when: a sample workflow runs two shards and posts one comment with images.

### AI6 — Failure triage
- MCP `triage_run(run_id)`: classify a failed run as app bug, test (locator) bug, flake or environment, with the
  reason and a minimal repro (the shortest step prefix that fails). Uses the run record only; no live app needed.
- Done when: fixtures for each class are classified correctly and the repro replays the failure.

### AI7 — Author by agent
- `explore(goal)`: an agent drives Nawi's MCP tools toward a goal and the session is saved as a flow. Exploration
  is non-deterministic; the saved flow replays deterministically.
- Flow drafts from a pull-request diff, a user story or a bug report. Always shown for review; never run unreviewed.
- Done when: a goal on a fixture app produces a flow that replays green three times in a row.

### AI8 — Reach
- Multi-viewport and device emulation runs, then Electron app targets (Nawi can test itself), then API steps in the
  same flow (the L3 HTTP family) and data-driven flows (A2).
- Other browser engines only if a non-CDP driver is justified; CDP covers Chromium-family browsers.

### AI10 — Trust and audit
- Per-run audit trace (who or what started it, which tools an agent called, what left the machine).
- Permission scopes for agent access (read run records, run flows, edit flows), enforced in the MCP dispatch.
- Done when: an agent without the edit scope cannot apply a healing proposal.

### AI11 — CLI parity and headless mode
- Every MCP tool has a CLI command (`nawi capture`, `record`, `flows`, `runs`, `heal`, `triage`, `baseline`, ...) with
  `--json` output, stable exit codes (0 pass, 1 test failed, 2 usage, 3 environment) and no GUI needed.
- `nawi serve`: run the engine headless as a local daemon (no window) that the CLI and MCP clients attach to.
- `nawi tools --json` prints every tool with its JSON Schema, so a harness can discover the surface.
- `nawi runs --follow` streams run events as NDJSON for scripts and agents.
- Done when: a script can record-less run, heal, accept a baseline and read results using only the CLI, and the CLI
  and MCP tool lists are checked equal by a test.

### AI12 — MCP hardening
- Transports: stdio (today) and local streamable HTTP with a bearer token; loopback only by default.
- Expose flows, run records and screenshots as MCP **resources**, and common jobs ("run and triage", "heal a flow")
  as MCP **prompts**.
- Long runs report progress and can be cancelled; the existing agent kill switch cancels them.
- Every tool has a schema, a documented error shape and a contract test.
- Done when: a generic MCP client lists resources, starts a run, sees progress and cancels it.

### AI13 — LLM provider layer
- One provider interface used by AI4, F6, AI6 and AI7: Anthropic, any OpenAI-compatible endpoint (including a local
  server), selected in settings or env; model id is configuration, never hard-coded in a slice.
- Cost and token caps per run, response caching keyed by input hash, and an offline mode that disables every model
  call (slices then report "not evaluated" instead of guessing).
- Redaction before send: secrets masked, request log shows exactly what left the machine (feeds AI10).
- Done when: the same flow runs against a stub provider, a local one and a hosted one with identical cached
  verdicts, and offline mode never makes a network call.

### AI14 — Harness integrations
- Agent-harness packaging: a ready-made skill and slash commands for Claude Code, a plain `AGENTS.md` snippet for
  other agent CLIs, and an example of Nawi as a tool in a custom Agent SDK loop.
- A typed TypeScript client (`nawi-client`) over the same API the CLI uses, for scripts and orchestrators.
- Webhooks and an event feed so an orchestrator can start a flow and receive the result (ties to the I5 triggers).
- Done when: an agent session with only the skill installed records-free authors a flow, runs it, reads a failure
  and applies a heal proposal without being told any tool names.

## Track M — Mobile apps: fast onboarding and smart configuration

Goal: a person (or an agent) gives Nawi an app file and gets a working, understood test target in a minute, with
no hand-written config. Android first (works on any host); iOS needs a macOS host and comes later. Builds on the
existing Android capture item (C5), the layered locators (AI1), the CLI/MCP surface (AI11, AI12) and the LLM
provider layer (AI13). Everything Nawi infers is shown as a proposal first; nothing changes the app or the device
config without confirmation.

### M1 — Drop-in onboarding
- Drag an `.apk` onto the window, or `nawi mobile open app.apk` (an `.aab` is converted with bundletool). Nawi reads
  the manifest and reports: package, launcher activity, min/target SDK, ABIs, permissions, deep links, whether it is
  debuggable, exported components.
- Then, in one flow with a progress view: find or guide the install of the Android SDK tools (adb, emulator), pick
  or create a matching virtual device (API level at or above min SDK, right ABI) or use a connected phone, boot it,
  install the app, grant the declared runtime permissions, launch it, and show the live screen next to the inspector.
- Saves the result as a mobile profile (`*.nawi.mobile.yaml`) that CLI and MCP can reuse.
- Done when: from a clean state, dropping a sample apk reaches "app running on a device" with no manual steps, and
  each failure (no SDK, no virtualization, ABI mismatch) gives one specific fix instead of a stack trace.

### M2 — Smart configuration
- Detect the framework from the package (native, Flutter, React Native, WebView-heavy) and pick the matching
  strategy for reading the screen: accessibility tree, the framework's semantics tree, or the WebView over CDP.
- Choose sensible defaults: device profile, locale, dark mode, font scale, animations off, network on, permission
  pre-grants; test accounts and API keys go through the secrets mechanism, never into the profile.
- Detect first-run blockers (permission dialogs, login wall, consent screens) and offer a reusable "get past
  onboarding" sub-flow.
- Done when: the three framework fixtures each pick the right strategy with no input, and the profile is stable
  across two runs.

### M3 — Study the app
- Dump and walk the view hierarchy (UI Automator and the accessibility service) and build a screen graph by
  safe exploration: taps on non-destructive controls only, a depth and time budget, and a "never press" list
  (delete, pay, send, sign out).
- Per screen: element inventory (resource id, content description, text, bounds, clickable, focusable), a
  screenshot, and a stable screen id so runs can be compared.
- Quality findings: missing content descriptions, touch targets under 48 dp, low contrast, duplicate or missing
  resource ids, locators that would be fragile (text-only, index-based).
- Done when: exploring a fixture app yields a screen graph that matches a hand-built expected one, and each
  finding class fires on a fixture that has the defect and stays quiet on one that does not.

### M4 — Suggestions
- From the screen graph, manifest and findings, propose: test ids or labels to add (as a patch the app developers
  can review), the most valuable flows to cover (sign-in, onboarding, the main path, permissions), config changes,
  and which screens deserve visual baselines.
- Heuristics first; the LLM (AI13) refines wording and flow drafts. Always a reviewable proposal with the evidence,
  exportable as a Markdown report and as flow drafts.
- Done when: a fixture app with known gaps gets the expected suggestions, and none is applied without confirmation.

### M5 — Mobile record and replay
- Record taps, swipes, long presses, text entry, back, home, rotation, deep links, permission dialogs, and app
  background and restore. Replay uses the layered locators (resource id, content description, text, bounds, image
  crop) with auto-wait and the same step format (`target.kind: android`).
- The run record adds screenshots per step, logcat for the step, screen recording, and any crash or ANR.
- Done when: a recorded flow on a fixture app replays green three times, and a crash is captured with its log.

### M6 — Device matrix
- Run one flow across several virtual devices or phones: API levels, screen sizes and densities, locales, dark
  mode, font scale, orientation. Parallel where the host allows.
- Network conditions (offline, slow), low-memory and process-death restore.
- Done when: one command runs a flow on two devices and the report shows the results side by side.

### M7 — Mobile quality signals
- Startup time, frame jank (from the platform's graphics stats), memory, ANR and crash counts, StrictMode
  violations, permission use; budgets that fail a run, like the web network budgets (AI3).

### M8 — iOS (macOS host only)
- Simulators through the platform tools: install, launch, accessibility hierarchy, screenshots and recording, with
  the same profile and flow format. Real devices later if justified.

### M9 — Cross-framework depth
- Flutter semantics tree, React Native test ids, WebView contexts driven over CDP from the same flow.

## Track E — Engines: DevTools, load testing and native mobile test libraries

Principle: do not re-invent what the platforms already ship. Nawi connects to the real engines, adds what they lack
(one timeline across them, flows, AI, proposals) and ingests their results into the same run record.

### DT1 — DevTools-grade browser recording
- Attach to the debug browser over CDP (the existing launcher) and record, per step and on one shared clock:
  network (HAR, redacted), console, DOM mutations, performance trace (a standard trace file that opens in the
  browser's own performance panel), code coverage, accessibility tree, storage and cookie changes, and screenshots.
- A single **step-correlated timeline** in Nawi: click a step to see what the page, network and CPU did during it.
  This is the "better than the panels" part: DevTools shows each stream separately, Nawi lines them up per step.
- Open the real DevTools front end against the same session when someone wants the full panels (D1), and export
  HAR, trace and an accessibility snapshot for other tools.
- Optional driver for non-Chromium engines through WebDriver BiDi, behind the same flow format, only if a user needs it.
- Done when: a recorded flow produces a run with the correlated timeline, the trace file opens in the browser's
  performance panel, and secrets are masked in every artifact.

### MN1 — Native mobile test libraries
- Default path stays the device-level driver (M5), which works on any apk with no source. When the project's own
  test setup is available, Nawi can use the platform's native libraries instead, for speed and fidelity:
  Android instrumentation (Espresso, UI Automator) via `adb shell am instrument`, iOS XCUITest through
  `xcodebuild test` on a macOS host, and Flutter `integration_test`.
- Two directions: run an existing native suite and ingest its results (JUnit, result bundles) into the run record
  with screenshots and logs; and export a Nawi flow as a native test (Kotlin, Swift, Dart) like the Playwright export (F8).
- Detect which libraries the project already uses (from the build files in a dropped project, or the manifest and
  test apk) and suggest the right backend in the mobile profile (M2).
- Done when: a sample project's native suite runs from `nawi mobile test`, appears in the same report as flow runs,
  and one exported flow compiles and passes as a native test.

### LT1 — Load testing with k6 (background)
- Generate a k6 script from a flow's recorded traffic (the HAR): correlated requests, think times, variables from
  data-driven inputs (A2). Ramp, soak and spike profiles with thresholds (p95 latency, error rate) as pass/fail.
- Run k6 as a managed background process (queued, resource-capped, cancellable), stream its metrics into the run
  record and the report, and keep the raw k6 summary and time series.
- **UI under load**: run a browser or mobile flow while a load profile runs, to see what a real user sees when the
  system is busy. Correlate the two timelines.
- Safety is part of the feature: target allowlist, an explicit confirmation before the first run against a new
  host, hard caps on virtual users and duration, refusing non-local hosts unless allowed, and no secrets in scripts.
- CLI `nawi load run|from-flow|results` and matching MCP tools (AI11, AI12).
- Done when: a flow becomes a k6 script that passes a threshold against a local fixture server, a failing threshold
  fails the run with the numbers in the report, and the safety checks block a non-allowlisted host.

## What this roadmap leaves out

Video export and a Rust sidecar (`docs/DRAFT-video-export-VEX.md`): useful for demos and bug clips, but not what
makes a better test tool. Revisit when VEX is built.
