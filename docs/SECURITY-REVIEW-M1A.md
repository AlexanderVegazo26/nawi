# Security Review — M1a (`m1a-state-layer`, `2b9840d..af34d35`)

**Mode:** Review (read-only). No source file was modified.
**Tier:** 3 — new trust boundary (loopback RPC reachable by any local process), new privileged operation (`capture_screen` over RPC), and a P0 secret-handling control.
**Scope:** redaction chokepoint (`seal.ts`, `writer.ts`, `harvest/*`, `inject/probe.js`, `inject/listener.js`), DC-3 transactionality (`store.ts`, `library.ts`, `mcp/revision.ts`), MCP surface (`mcp/*`, `src/mcp/stdio-bridge.ts`), FR-SEC.1.

---

## Verdict on FR-SEC.2 — **the acceptance criterion does not hold as written**

The acceptance names four sinks: `input_events`, DOM snapshot, HAR, transcript. Three are genuinely defended. **The HAR is not.**

`src/main/harvest/har.ts:169` captures `request.postData` verbatim and `har.ts:278-299` (of 334) emits it as `request.postData.text`, capped at 256 KB. A login form submits the typed password in that body. Tier A strips only `authorization` / `proxy-authorization` / `cookie` / `set-cookie` headers (`har.ts:25-31`) — nothing touches the body. Tier B's pattern set (`seal.ts:107-155`) matches structured secret *shapes*; an arbitrary user password matches none of them. So a keystroke value from a password field reaches `network.har` on disk and is readable by raw file access.

The gate test does not catch this because its fixture types into fields and never submits a form (`redaction.gate.test.ts:150-250`). Its byte scan is genuine and its non-vacuity controls are unusually good — it just never exercises the sink.

**Two caveats that determine how you should act on this.**

1. **The production harvest path is not wired.** `Harvester` has no caller in `src/main/index.ts` (only `startMcpServer()` at `index.ts:688`). No production code passes harvested files to `seal()`. So today no browser state layer is written at all, and there is nothing live to leak. The correct statement is: *the milestone's harvest→seal→write pipeline, as it will be wired, violates FR-SEC.2's HAR clause; it is currently unreachable.* That makes this cheap to fix now and expensive later.
2. **"Wire up `suppressedValues`" is not a complete fix.** Literal matching (`seal.ts:289-306`) cannot see `password=hunter%212` in a URL-encoded form body, nor a JSON-escaped or base64 one. The HAR needs a Tier A control at ingest — see F1's mitigation.

**What the password case actually rests on, where it does hold.** For the DOM snapshot and AX tree, the password result is over-determined: Chromium masks `input[type=password]` in `DOMSnapshot` on its own *and* the marker/backendNodeId filter runs. The gate test's control at `redaction.gate.test.ts:287` proves the filter is doing real work for the pre-marking case, but it does not separate the two mechanisms for the post-filter result. The **non-password kinds** (`one-time-code`, configured selectors) are the real test, and they are systematically weaker — see F2/F3/F4, which all share the precondition *"the secret element is not an `input[type=password]`."*

---

## Findings, ranked by real exploitability

### F1 — Critical: typed secrets survive in `network.har` via `request.postData`
- **Where:** `src/main/harvest/har.ts:169` (capture), `har.ts:~278-299` (emit), `harvest.ts:507` (written as `network.har`).
- **Attack:** no attacker needed. User records a login, types a password, submits. `network.har` in the revision directory contains `password=<value>`.
- **Fires when:** the harvester is wired into a capture flow and the recorded page submits credentials by form POST or JSON body — i.e. the exact scenario FR-SEC.2's acceptance describes.
- **Mitigation:** Tier A at ingest in `HarBuilder.requestWillBeSent`, matching the module's own stated philosophy. Two options: (a) drop `postData` entirely for `application/x-www-form-urlencoded` / `multipart/form-data` unless explicitly opted in; (b) hand `HarBuilder` the live set of secret field *names* from the probe and null the matching parameters. (b) is better but needs the probe to report names, which it does not today. Do not rely on `suppressedValues` alone.

### F2 — High: `layout.text` is neither redirected nor blankable, so a non-input secret's rendered text survives the snapshot filter
- **Where:** `src/main/harvest/snapshot.ts:177-212` (redirect loop covers `nodeValue`, `attributes`, `textValue`, `inputValue`, `currentSourceURL`, `originURL` — **not** `layout.text`), and `snapshot.ts:117` counts `layout.text` as *referenced*, which also prevents the second-mechanism blanking pass at `snapshot.ts:221-227` from clearing the string.
- **Attack:** a secret element that renders as a real DOM text node with a layout box — a `<div data-nawi-secret>` showing an OTP, a `contenteditable` matching a workspace-configured selector. The text child's `nodeValue` is correctly redirected; `layout.text[k]` for the same node still points at the original string-table entry, and the entry stays in `strings[]` verbatim.
- **Fires when:** the secret is not an `<input>`. `<input>` values render in a UA shadow tree, and `captureSnapshot` is called without `includeUserAgentShadowTree` (`harvest.ts:401-409`), so input values do not appear in `layout.text` — which is why the gate test, whose three secret fields are all `<input>`, passes.
- **Mitigation:** add `layout.text` to the redirect loop, keyed on `layout.nodeIndex[k] ∈ secretNodeIndices`. One loop, ~6 lines.

### F3 — High: `markSecrets()` does not pierce shadow roots or same-origin iframes
- **Where:** `src/main/cdp/inject/probe.js:249` (`document.querySelectorAll('*')`), invoked once in the main frame via `Runtime.evaluate` (`cdp/probe.ts:141`).
- **Attack:** a password or `one-time-code` field inside an open shadow root, or inside a same-origin iframe, is never stamped with `data-nawi-secret-target`. `DOM.getDocument({pierce:true})` + `querySelectorAll` at `probe.ts:145-153` would find such elements — but only if something had marked them, and nothing did. The snapshot then serializes the subtree unfiltered, and `buildAxTree` sees an empty secret set for those nodes.
- **Evidence the code knows shadow content is in scope:** `snapshot.ts:61` declares `shadowRootType` in its own `SnapshotNodes` interface.
- **Fires when:** the secret field is in a shadow root or a same-origin iframe (embedded auth widgets, design-system components). For `input[type=password]` Chromium's own masking still covers it; for `one-time-code` and configured selectors it does not.
- **Not affected:** cross-origin iframes are OOPIFs — separate CDP targets with no session attached, absent from the snapshot entirely. Fail-closed.
- **Mitigation:** walk shadow roots (`el.shadowRoot`) and same-origin frames recursively in `markSecrets`, or run the marking expression against every execution context rather than only the default one.

### F4 — Medium: the `role-name` selector re-embeds the accessible name that `describeInput` just suppressed
- **Where:** `src/main/cdp/inject/probe.js:280` nulls `target_name` for a secret target, then `:281` calls `describeSelectors(el)`, which at `:171-187` recomputes the same `accessibleName(el)` and embeds it in the selector string `role=…[name="<value>"]`. That string flows through `harvest.ts:157-167` into `input_events.ndjson` as a `SelectorCandidate.value`.
- **Attack:** click or input on a non-`<input>` secret element that has an explicit `role` attribute (or is one of `IMPLICIT_ROLES`) and whose visible text is the secret. `accessibleName` falls back to `el.textContent.trim().slice(0,120)` at `probe.js:119`.
- **Fires when:** the element is not an `<input>` (an `<input>` has empty `textContent`, and its label/placeholder fallbacks are not the value). So: configured-selector and `data-nawi-secret` secrets on text-bearing elements.
- **Related, unconditional:** `probe.js:302-305` `describePoint` returns `accessibleName(el)` with **no secret check at all**. It is not written to a sidecar today (FR-CAP.5 element picking is not wired), but it is the same bug with no precondition — fix it at the same time.
- **Mitigation:** pass the `secret` flag into `describeSelectors` and suppress the `role-name` candidate (or blank its `name`) when set.

### F5 — Medium: the MCP bearer token is readable by every same-user process, and that buys `capture_screen`
- **Where:** `src/main/mcp/server.ts:336-343`.
- **The author's `chmod 0600` note is directionally right but not the real issue.** `%APPDATA%` already carries an NTFS ACL that denies other non-admin users, so cross-user read is not the exposure. The exposure is **same-user processes**: an npm `postinstall`, an editor extension, any binary the user runs. None of them is stopped by any file mode on any platform.
- **What that principal gets:** the full tool set, including `capture_screen` (silent screen exfiltration of whatever is on the display) and `get_state_layer` over every stored capture. This is not fixable by permissions, which is what makes the consent/visibility model load-bearing rather than decorative.
- **Web-page reachability is closed.** `assertLoopbackTrust` (`dispatch.ts:186-196`) rejects any non-null, non-empty `Origin`. A browser attaches `Origin` to every cross-origin `fetch` and to form POSTs and cannot suppress it, so DNS rebinding and simple/no-preflight CSRF are both closed — and the page would need the 256-bit token anyway. No CORS headers are emitted (`server.ts:136-145`), so even a leaked response is unreadable. This part is correct.
- **Mitigation (product, not code):** UX-AGT.1/2/3 as built are *post-hoc* — the capture appears in the library and the tool-call log records it. There is no pre-capture consent prompt and no persistent "an agent is watching" indicator. For a P0 screen-exfiltration primitive reachable by any same-user process, that is thin. Recommend either a first-use-per-session consent gate for `capture_screen`, or a always-visible indicator. This is a `solution-architect` / product call, not mine to make.

### F6 — Medium: the agent kill switch is not fail-closed against settings loss
- **Where:** `src/shared/settings.ts:94` (`agentAccessPaused: false` in `defaultSettings()`), consumed via `mergeSettings` at `settings.ts:258-259`, read per call at `server.ts:170` / `dispatch.ts:~230`.
- **The per-call read is correct** and the switch cannot be bypassed on any path: `dispatch()` is the only route to a tool body, the HTTP layer never calls `tool.run` directly, and the stdio bridge holds zero policy (`stdio-bridge.ts` forwards verbatim and re-reads `mcp.json` per request). `initialize` and `tools/list` are not pause-gated, which is fine — they expose no capture.
- **The gap:** a deleted, truncated, or unparseable settings file falls back to `defaultSettings()`, where paused is `false`. A user who pauses agent access and later loses the settings file silently gets agent access back. A malicious same-user process can force this by deleting the file.
- **Mitigation:** persist the pause state where a read failure resolves to `true`, or treat "settings could not be read" as paused rather than as defaults.

### F7 — Medium: `writer.ts`'s compile-time guarantee is overstated; a second unsealed write path exists
- **Where:** `src/main/sidecar/writer.ts:10-19` claims "nothing unsealed reaches disk" is compiler-enforced. `src/main/library.ts:224-244` `saveSidecarRevision` accepts a plain `Sidecar` and calls `writeRevisionAtomically` directly. `mcp/tools.ts:508-528` already uses it, with an `as Parameters<typeof library.saveSidecarRevision>[1]` cast to get there.
- **Not exploitable today:** `annotate`'s carried-forward files come out of an already-sealed revision, so no unscanned content is introduced. The `redact` tool is deliberately unavailable.
- **Why it still matters:** the brand is the milestone's stated enforcement mechanism, and it is currently a convention with a docstring. The author's "untidy, not exploitable" read is right about today and wrong about the invariant.
- **The actual blocker to fixing it, so this is actionable:** `carryForwardFiles` (`mcp/revision.ts:56-77`) returns `Uint8Array` contents, and `seal()` throws on non-string contents (`seal.ts:414-419`). Routing `annotate` through `seal()` requires a binary-content policy first — exactly the "deliberate decision, not an accident" the seal docstring asks for. Recommend: decide the binary policy, then narrow `saveSidecarRevision`'s parameter to `SealedSidecar`.

### F8 — Medium: the page can forge state-layer entries through the CDP binding
- **Where:** `harvest.ts:242` exposes `Runtime.addBinding` name `__nawiEmit` to the page; `harvest.ts:304-321` accepts any JSON payload with a numeric `at`.
- **Attack:** a hostile or compromised page calls `window.__nawiEmit(JSON.stringify({type:'input', at:…, value:'…', value_redacted:false, …}))` and writes arbitrary entries into `input_events.ndjson`. It can also overwrite `window.__nawiProbe.describeInput` (`probe.js:293`) or strip the marker attribute, defeating Tier A for its own document. Console entries are equally forgeable via `console.log`.
- **Impact is not secret disclosure** — the page already has its own secrets. It is **agent-context poisoning**: this artifact is designed to be fed to an agent, so forged entries are an indirect prompt-injection channel into whatever consumes `get_state_layer`. This is the agent-native product's characteristic risk and is worth a standing entry in `risks.md`.
- **Mitigation:** cannot be fully closed page-side (the binding must be callable from the page). Reduce blast radius: randomize the binding name per session (it is a fixed constant today), and treat the state layer as untrusted input in any downstream agent-facing surface.

### F9 — Low: astral-plane keystrokes are recorded from secret fields
- **Where:** `harvest/inject/listener.js:87` — `if (e.key && e.key.length === 1) return`. An emoji or other non-BMP character has `e.key.length === 2`, so it is *not* filtered and is attached as `described.key` at `:92`, with no secret check.
- **Impact:** a literal keystroke value from a password field lands in `input_events`. Narrow (non-BMP characters in passwords), but it is a direct textual violation of the acceptance clause.
- **Mitigation:** use a code-point count, and suppress `key` entirely when `value_redacted` is true.

### F10 — Low: user-regex ReDoS in `seal()` — the author's framing overstates it
- **Where:** `settings.ts:211-224` `sanitizeRedactionRules` validates shape only; `seal.ts:240-255` compiles and `seal.ts:308-321` runs the rule over multi-MB HAR content.
- **Reachability:** the rule must come from the settings file or renderer IPC. No MCP tool mutates settings (`tools.ts` only calls `settings.getSettings()` at `:163`). So the attacker needs same-user write access — at which point they have better options. It is a footgun, not an attack vector.
- **Impact if it fires:** synchronous catastrophic backtracking in Electron main — frozen UI, no capture, no crash report.
- **Mitigation:** low priority. If it becomes reachable (FR-CLI.4's repo-checked-in `aperture.config.json` would do it), it becomes Medium immediately. Options: length/complexity bounds, or run Tier B's user rules in a worker with a timeout.

### F11 — Informational: `tierAFailures` is a test-time mechanism only
Confirmed. `suppressedValues` is populated only in `redaction.gate.test.ts:255`; no production caller supplies it, so `tierAFailures` is always empty in production. Nothing reads it as evidence of safety: the only production consumer is `tools.ts:165-173`, which logs to `console.error` and does not gate the write. That is honest — but it means the report field is *not* a runtime safety signal, and any future release gate that asserts `tierAFailures.length === 0` against a production capture would be asserting a tautology. Worth a comment at the field's declaration.

### F12 — Informational: `applied_to` is empty for console-only hits
Confirmed and correctly documented at `seal.ts:376-379`. The text *is* redacted and the hit *does* appear in `report.hits`; only the DC-4 label is missing because `RedactionTarget` has no console member. Deferring rather than widening a shared contract was the right call. Fix when DC-4 is next revised.

---

## FR-SEC.1 — local-only: **correct**

A listening loopback socket is not egress, and classifying it as such (`server.ts:59-61`, `egress: false`) is right. Verified no outbound connection is made by the reviewed code: the CDP client connects to a locally-launched browser, and `stdio-bridge.ts` `fetch`es `127.0.0.1` only. The one thing to keep an eye on: the bridge trusts whatever `url` is in `mcp.json` (`stdio-bridge.ts:63-71`) without checking it is loopback. A same-user process that rewrites `mcp.json` could point the bridge at a remote host and turn it into an exfiltration channel for the agent's own traffic. Low, same-user precondition, but a two-line hostname assertion closes it.

## DC-3 transactionality — sound

The write is staged then landed by a single `rename`, and the index pointer flips only afterwards (`library.ts:244-251`), so a crash leaves a complete-but-orphaned directory that `readSidecar` will not resolve. Concurrent writes are serialized on `sidecarChain`. `nextRevision` folds in both the on-disk and index views. The pixel/state pairing question does not arise in M1a because `redact` is deliberately unavailable (`tools.ts:~548`) and refuses precisely on DC-3 grounds — a good call, correctly reasoned. The only real DC-3 seam is F7, which is a type-safety gap rather than a transactional one.

---

## Release gate recommendation for `release-manager`

- **Blocking:** F1 (Critical), F2, F3 (High). All three are FR-SEC.2, which is the milestone's own P0 and the PRD's named top risk.
- **Should-fix before the harvester is wired:** F4, F5, F6, F7, F8.
- **Non-blocking:** F9–F12.

F1/F2/F3 are all fixable within this milestone's files and none requires an architecture change. The mitigations for F2 and F4 are each under ten lines.

## Handoffs

- **`qa-engineer`** owns the execution-dependent half of this review. Everything above is static analysis; I did not run an exploit. Specifically needed: extend `redaction.gate.test.ts` with (a) a form POST carrying a typed secret, asserting absence from `network.har`; (b) a `one-time-code` and a configured-selector secret on a **non-`<input>`** text-bearing element, which is the F2/F4 case; (c) the same inside a shadow root and a same-origin iframe (F3). The existing gate test's structure — typed sentinels, byte scan, explicit non-vacuity controls — is the right shape; it just needs these three cases.
- **`solution-architect`** owns the F5 consent-model question (pre-capture gate vs. persistent indicator for `capture_screen`) and the F7 binary-content policy that unblocks unifying the two write paths.
- **No risk is accepted here.** F1's blocking status is a recommendation; accepting it is the owning human's or `release-manager`'s call.
