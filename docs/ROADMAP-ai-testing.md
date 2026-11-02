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

Order: F4c (HTML report) → AI1 + F6 → AI2 (with F5) → AI3 → AI5 → AI4 → AI9 → AI6 → AI7 → AI8 → AI10.

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

## What this roadmap leaves out

Video export and a Rust sidecar (`docs/DRAFT-video-export-VEX.md`): useful for demos and bug clips, but not what
makes a better test tool. Revisit when VEX is built.
