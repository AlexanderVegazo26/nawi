# PRD-001 — Aperture: Agent-Native Screen Capture Platform

> **Codename:** `Aperture`. Rename globally before implementation if desired (`rg -l Aperture | xargs sed -i 's/Aperture/YourName/g'`).
> **Status:** Draft v1.0
> **Owner:** TBD
> **Consumers:** Claude Code agents, engineering, design, QA
> **Companion doc:** `PRD-002-user-experience.md` (UX, IA, interaction, accessibility)

---

## 0. How agents should use this document

1. Requirements are identified as `FR-<area>.<n>` (functional), `NFR-<n>` (non-functional), `DC-<n>` (data contract).
2. Every requirement carries a priority: **P0** (must ship in M1), **P1** (must ship by GA), **P2** (post-GA).
3. Implement in the order given by §12 Build Order. Do not start a milestone until the prior milestone's Definition of Done passes.
4. When a requirement is ambiguous, prefer the interpretation that keeps the **structured capture layer** intact (§5). That layer is the product's differentiator; pixel fidelity is table stakes.
5. Do not invent scope. Anything not listed in §3 is out of scope. If a dependency is genuinely required and unlisted, open a `SCOPE-QUESTION` comment in the PR rather than building it.
6. Every FR must ship with tests satisfying its acceptance criteria. A requirement without a passing test is not done.

---

## 1. Problem statement

Screen capture tools were designed for a world where the only consumer of a screenshot was a human eye. That assumption is now wrong. Screenshots and screen recordings are increasingly consumed by AI agents — as bug context, as UI specs, as test fixtures, as training and evaluation data, as audit records of what an autonomous agent did.

Existing tools throw away everything except pixels. The DOM was there. The accessibility tree was there. The console errors, the network calls, the exact selector the user clicked — all discarded at the moment of capture, then laboriously and unreliably reconstructed later by an OCR pass or a vision model.

The result is three concrete failures:

- **Support and QA:** a bug report is a PNG plus prose. The engineer re-reproduces from scratch. The agent asked to triage it guesses at what it is looking at.
- **Documentation:** a step-by-step guide goes stale the moment the UI ships a change, and nobody knows which of the 40 steps broke.
- **Agent observability:** when an autonomous agent operates a browser or desktop, there is no artifact that pairs what appeared on screen with what the agent decided and why.

## 2. Goals and success metrics

| # | Goal | Metric | Target (GA + 90d) |
|---|---|---|---|
| G1 | Capture is instant and reliable | p95 hotkey-to-capture-ready latency | < 800 ms |
| G2 | Captures carry machine-readable state | % of browser captures with complete structured sidecar | > 95% |
| G3 | Agents can drive the tool | MCP tool-call success rate | > 98% |
| G4 | Guides stay alive | % of guide steps auto-healed after a UI change vs. manually re-recorded | > 70% |
| G5 | Nothing leaks | Captures shared containing undetected PII (sampled audit) | < 0.5% |
| G6 | Recording is cheap | CPU overhead during 1080p60 capture on baseline hardware | < 12% |

### Anti-goals (explicit)

- We are not building a video editor that competes on timeline depth.
- We are not building a general-purpose observability/APM product.
- We are not building an RPA execution engine. We *emit* automation; we do not run it in production.

## 3. Scope

### In scope (v1)
Capture, recording, annotation, guide generation, structured sidecar capture, MCP server, sharing, redaction, integrations listed in §10.

### Out of scope (v1)
- Live streaming / broadcast
- Real-time multi-user screen sharing (we are asynchronous)
- Mobile *device* capture beyond emulator/simulator and screen-mirroring (native iOS/Android agents are P2)
- On-prem self-hosted deployment (P2)
- Video hosting at CDN scale beyond 5 GB per workspace (P1 raises this)

## 4. Personas and primary jobs

| Persona | Job to be done | Primary surface |
|---|---|---|
| **Ana — QA engineer** | Capture a failing flow with logs and DOM attached, file it to ADO, and get a runnable Playwright script out | Desktop app + CLI |
| **Marcus — support agent** | Grab a customer's screen state, redact PII, and attach it to a Zendesk ticket in under 30 seconds | Browser extension |
| **Priya — technical writer** | Record a workflow once, produce a 20-step guide, and have it self-heal when the product changes | Web app |
| **Dev-agent** (non-human) | Request a capture of a running app, read back the structured state, and reason about the UI | MCP server |
| **Rita — engineering manager** | Review what an autonomous agent did on screen last night, with its tool calls aligned to the video | Web app |

## 5. Architecture: the two-layer capture model

This is the load-bearing concept. Implement it before anything else.

Every capture produces **two layers**, always, atomically:

```
Capture
├── Pixel layer      — frames, video, audio (what it looked like)
└── State layer      — structured, timestamp-aligned facts (what it was)
    ├── dom_snapshot        (browser/electron only)
    ├── accessibility_tree  (all platforms where available)
    ├── console_log[]
    ├── network_har
    ├── input_events[]      (clicks, keys, scrolls, with targets)
    ├── window_metadata     (app, title, bounds, DPR, OS, locale)
    └── agent_trace[]       (optional; tool calls + reasoning, see FR-AGT)
```

**Invariant DC-1:** Every entry in the state layer carries `t_ms`, an offset from `capture.started_at`, on the same monotonic clock as the pixel layer. Any state event that cannot be timestamped is dropped, not guessed.

**Invariant DC-2:** The state layer is optional to *consume* but never optional to *attempt*. If a source is unavailable (e.g. no DOM on a native desktop capture), the sidecar records `{"dom_snapshot": null, "reason": "unsupported_surface"}` rather than omitting the key.

**Invariant DC-3:** Redaction applied to the pixel layer must be applied to the corresponding state layer in the same transaction. A blurred password field whose value survives in the DOM snapshot is a P0 security bug.

---

## 6. Functional requirements

### 6.1 Capture — `FR-CAP`

| ID | Pri | Requirement |
|---|---|---|
| FR-CAP.1 | P0 | Capture region, active window, and full screen via global hotkey, on all supported OSes. |
| FR-CAP.2 | P0 | Multi-monitor support including mixed DPI; output preserves each display's native pixel ratio. |
| FR-CAP.3 | P0 | Capture result lands on the system clipboard immediately, before any upload completes. |
| FR-CAP.4 | P0 | Freeze-screen mode: the screen is frozen at hotkey press so hover states, tooltips, and open menus survive selection. |
| FR-CAP.5 | P0 | Element-aware capture: hovering highlights the underlying DOM node (browser) or accessibility element (desktop); a click captures its exact bounds. |
| FR-CAP.6 | P1 | Scrolling capture with seam-free stitching. Must handle sticky headers, lazy-loaded content, and virtualized lists by scroll-step + dedupe, not naive concatenation. |
| FR-CAP.7 | P1 | Delayed capture (configurable 1–30 s) and repeat-last-region. |
| FR-CAP.8 | P1 | Configurable output scaling (1x / 2x / native) independent of capture DPR. |
| FR-CAP.9 | P2 | Capture from a headless browser context in CI (see FR-CLI). |

**Acceptance — FR-CAP.4**
```
GIVEN a dropdown menu is open on screen
WHEN the user presses the capture hotkey and takes 5 seconds to drag a selection
THEN the captured image contains the dropdown in its open state
AND no repaint of the underlying application occurred in the captured frame
```

**Acceptance — FR-CAP.5**
```
GIVEN a browser page with a button of id "checkout-submit"
WHEN the user hovers that button in element-aware mode
THEN a highlight matches the button's border-box within 1 device pixel
AND capturing it produces a sidecar containing that element's selector, role, and accessible name
```

### 6.2 Recording — `FR-REC`

| ID | Pri | Requirement |
|---|---|---|
| FR-REC.1 | P0 | Record screen, system audio, microphone, and webcam as independently muteable tracks. |
| FR-REC.2 | P0 | Pause / resume without producing a discontinuity artifact in the output. |
| FR-REC.3 | P0 | Crash safety: if the app or OS dies mid-recording, the partial recording is recoverable on next launch with no more than 5 s of loss. |
| FR-REC.4 | P0 | Export MP4 (H.264 + AAC). WebM and GIF at P1. |
| FR-REC.5 | P1 | Retroactive capture: a low-cost ring buffer runs on demand; "save last N seconds" (N configurable to 300) materializes a recording of something that already happened. |
| FR-REC.6 | P1 | Cursor smoothing, click ripple highlighting, and auto-zoom toward the region of activity. |
| FR-REC.7 | P1 | Keystroke overlay with automatic suppression of input into password/secret fields. |
| FR-REC.8 | P1 | Chapter markers insertable during recording via hotkey. |
| FR-REC.9 | P2 | Re-record narration over an existing video without re-recording the screen track. |

**Acceptance — FR-REC.3**
```
GIVEN a recording has been running for 10 minutes
WHEN the process is SIGKILLed
THEN on next launch the user is offered a recoverable recording
AND the recovered file is playable and at least 9m55s long
AND its sidecar state layer is intact up to the same timestamp
```

**Acceptance — FR-REC.5**
```
GIVEN ring-buffer mode is enabled with N=120
WHEN the user triggers "save last 120 seconds"
THEN a recording of the preceding 120 seconds is produced within 3 seconds
AND steady-state memory usage of the ring buffer stays under 1.5 GB at 1080p30
```

### 6.3 Structured capture — `FR-STA`  ← highest-value area

| ID | Pri | Requirement |
|---|---|---|
| FR-STA.1 | P0 | On browser captures, serialize a DOM snapshot (nodes, attributes, computed styles for layout-affecting properties, scroll offsets) at capture time. |
| FR-STA.2 | P0 | Capture the accessibility tree (role, name, value, state, bounds) on every supported surface. |
| FR-STA.3 | P0 | Capture console entries with level, message, and stack, for the recording window plus 30 s of preamble. |
| FR-STA.4 | P0 | Capture input events with `{t_ms, type, target_selector, target_role, target_name, coordinates}`. Key *values* are captured only for non-secret fields (see FR-SEC.2). |
| FR-STA.5 | P1 | Capture network activity as HAR, with request/response bodies subject to size cap (default 256 KB) and redaction rules. |
| FR-STA.6 | P1 | Selector generation must prefer stability: `data-testid` > `id` > `role+name` > scoped CSS > nth-child. Emit *all* candidates ranked, not just the winner. |
| FR-STA.7 | P1 | Timestamp alignment: state events and video frames resolve to the same monotonic clock; drift over a 30-minute recording < 100 ms. |
| FR-STA.8 | P2 | Desktop-native structured capture via platform accessibility APIs (UIAutomation / AX / AT-SPI). |

**Acceptance — FR-STA.6**
```
GIVEN a button rendered as <button data-testid="submit" id="s1" class="btn btn-primary">Save</button>
WHEN the user clicks it during a recording
THEN the sidecar input event contains a ranked selector array whose first entry is [data-testid="submit"]
AND contains at least three distinct candidate strategies
AND each candidate is annotated with a stability score in [0,1]
```

### 6.4 Annotation and editing — `FR-ANN`

| ID | Pri | Requirement |
|---|---|---|
| FR-ANN.1 | P0 | Arrow, rectangle, ellipse, freehand, text callout, numbered step badge with auto-increment. |
| FR-ANN.2 | P0 | Annotations are non-destructive objects; the original frame is always recoverable. |
| FR-ANN.3 | P0 | Blur, pixelate, and solid redaction. Redaction is **destructive on export** — the underlying pixels must not exist in the exported artifact. |
| FR-ANN.4 | P1 | Text callouts auto-select a contrasting color against the pixels beneath them (WCAG AA against sampled background). |
| FR-ANN.5 | P1 | Spotlight/dim, crop, magnifier inset. |
| FR-ANN.6 | P1 | Video trim, cut, splice, silence removal, speed ramps. |
| FR-ANN.7 | P1 | Brand kits: colors, fonts, cursor style, intro/outro frames, applied as a workspace default. |
| FR-ANN.8 | P2 | Annotations anchored to a *state-layer element* rather than to pixel coordinates, so they survive a re-capture of the same screen at a different size. |

**Acceptance — FR-ANN.3**
```
GIVEN an image with a redaction rectangle over an email address
WHEN the image is exported as PNG
THEN no pixel data from the original region exists anywhere in the file, including metadata and thumbnails
AND the corresponding DOM snapshot has that text node replaced with a redaction sentinel
```

### 6.5 Guide generation — `FR-GDE`

| ID | Pri | Requirement |
|---|---|---|
| FR-GDE.1 | P0 | Convert a recording into an ordered step list: one step per meaningful interaction, each with a cropped screenshot, auto-numbered badge on the target, and generated step text. |
| FR-GDE.2 | P0 | Steps are editable: merge, split, reorder, retitle, delete, re-crop — without re-recording. |
| FR-GDE.3 | P0 | Export to Markdown and HTML. PDF, DOCX, Confluence, Notion at P1. |
| FR-GDE.4 | P1 | Auto-generated alt text for every step image, editable, included in all exports. |
| FR-GDE.5 | P1 | Guide versioning with step-level diff between two recordings of the same flow. |
| FR-GDE.6 | P1 | **Auto-heal:** given a stored guide and a fresh run of the same flow, identify which steps' targets still resolve, re-capture only the changed steps, and flag steps whose target no longer exists for human review. |
| FR-GDE.7 | P2 | Localization: translate step text and re-render text annotations in the target language. |
| FR-GDE.8 | P2 | Interactive demo export — clickable HTML replay driven by the state layer. |

**Acceptance — FR-GDE.6**
```
GIVEN a 12-step guide recorded against app version 1.0
AND app version 1.1 changed the styling of steps 4 and 5 and removed the target of step 9
WHEN auto-heal runs
THEN steps 4 and 5 are re-captured with updated screenshots and unchanged step text
AND step 9 is flagged BROKEN with the last-known selector and a diff summary
AND steps 1-3, 6-8, 10-12 are untouched (byte-identical images)
```

### 6.6 AI features — `FR-AI`

| ID | Pri | Requirement |
|---|---|---|
| FR-AI.1 | P0 | Transcription of audio tracks with word-level timestamps and speaker labels. |
| FR-AI.2 | P0 | OCR of every keyframe; extracted text is indexed for search. |
| FR-AI.3 | P0 | Sensitive-data detection over pixels, OCR text, DOM text, and HAR bodies; proposes redactions before share. Detects at minimum: email, phone, national ID patterns, card numbers, API keys/tokens, JWTs, private keys, and `Authorization` headers. |
| FR-AI.4 | P1 | Auto-title, auto-summary, and auto-tagging of each capture. |
| FR-AI.5 | P1 | Semantic search across the workspace library, spanning transcript, OCR, DOM text, and step text. |
| FR-AI.6 | P1 | Auto-narration generated from the state layer (not from vision alone) — the action stream is the ground truth for what happened. |
| FR-AI.7 | P1 | Filler-word and dead-air removal. |
| FR-AI.8 | P2 | Natural-language editing ("cut the failed login attempt, zoom on the error toast"), resolved against the state layer. |
| FR-AI.9 | P2 | On-device inference option for workspaces that forbid cloud processing. |

**Note for implementing agents:** FR-AI.6 is deliberately grounded in the state layer. Do not implement narration as a pure vision-model caption pass. The input event stream tells you what was clicked and what its accessible name was; the model's job is phrasing, not perception.

### 6.7 Agent interface — `FR-AGT`  ← the differentiator

| ID | Pri | Requirement |
|---|---|---|
| FR-AGT.1 | P0 | Ship an MCP server exposing, at minimum: `capture_screen`, `capture_region`, `capture_element`, `start_recording`, `stop_recording`, `get_capture`, `get_state_layer`, `list_captures`, `search_captures`, `annotate`, `redact`, `export_guide`. |
| FR-AGT.2 | P0 | `get_state_layer` returns the full sidecar as JSON conforming to the schema in §7. Token-bounded: support `fields[]` projection and pagination so an agent can request only the accessibility tree, or only console errors. |
| FR-AGT.3 | P0 | Every MCP tool is idempotent where semantically possible and returns a stable `capture_id`. |
| FR-AGT.4 | P1 | `capture_as_context`: single call returning a bundle (image + trimmed state layer + summary) sized to a configurable token budget, intended for direct injection into an agent's context window. |
| FR-AGT.5 | P1 | **Record-to-test:** emit a runnable Playwright (TypeScript) script from a recording, using the ranked selectors from FR-STA.6, with generated assertions derived from observed state transitions. Cypress and Appium at P2. |
| FR-AGT.6 | P1 | **Agent observability:** accept an `agent_trace` stream (tool calls, arguments, results, optional reasoning summaries) over the API during a recording; align it to the video timeline and render it as a synchronized side panel. |
| FR-AGT.7 | P1 | Visual diff against a stored baseline, returning both an image diff and a **structured** diff (which elements moved, appeared, disappeared, changed text). |
| FR-AGT.8 | P2 | Human-in-the-loop approval flow: an agent proposes annotations/redactions; a human approves, rejects, or edits before the artifact is shareable. |

**Acceptance — FR-AGT.5**
```
GIVEN a recording of a login flow with 6 interactions against a stable test app
WHEN record-to-test emits a Playwright script
THEN the script runs green against the same app on first execution
AND contains at least one assertion per navigation boundary
AND uses no nth-child selector where a data-testid or role+name selector was available
```

**Acceptance — FR-AGT.2**
```
GIVEN a 10-minute recording with a 40 MB state layer
WHEN an agent calls get_state_layer with fields=["console_log"] and level="error"
THEN the response contains only error-level console entries
AND the response is under 32 KB
AND each entry retains its t_ms and a link to the corresponding video timestamp
```

### 6.8 CLI and CI — `FR-CLI`

| ID | Pri | Requirement |
|---|---|---|
| FR-CLI.1 | P1 | Headless capture and recording invocable from CI with deterministic output paths. |
| FR-CLI.2 | P1 | `aperture diff --baseline <id> --candidate <id>` returns exit code 1 on regression and writes a machine-readable report. |
| FR-CLI.3 | P1 | Artifact upload with a returned permalink, suitable for attaching to a pipeline run. |
| FR-CLI.4 | P2 | Config via `aperture.config.json` checked into the repo (redaction rules, brand kit, selector strategy). |

### 6.9 Sharing and collaboration — `FR-SHR`

| ID | Pri | Requirement |
|---|---|---|
| FR-SHR.1 | P0 | Share link generated at capture completion, before editing. |
| FR-SHR.2 | P0 | Link controls: expiry, password, workspace-only, domain allowlist, disable download. |
| FR-SHR.3 | P1 | Timestamped comments on video; region-anchored comments on stills; threads and resolution. |
| FR-SHR.4 | P1 | View analytics: viewers, watch-through rate, drop-off points. |
| FR-SHR.5 | P1 | Shared libraries with folders, tags, and search. |
| FR-SHR.6 | P2 | Real-time co-annotation. |

### 6.10 Security, privacy, governance — `FR-SEC`

| ID | Pri | Requirement |
|---|---|---|
| FR-SEC.1 | P0 | Local-only mode: capture, edit, and export with zero network egress. Must be verifiable — the app surfaces a network activity indicator. |
| FR-SEC.2 | P0 | Secret-field suppression: input into fields typed `password`, marked `autocomplete="one-time-code"`, or matching workspace-configured selectors is never recorded in the state layer, in any form. |
| FR-SEC.3 | P0 | App/window masking: designated applications or window titles are blacked out in the pixel layer at capture time, not in post. |
| FR-SEC.4 | P0 | Audit log: capture, view, export, share, and delete events, with actor and timestamp, retained per workspace policy. |
| FR-SEC.5 | P1 | SSO (SAML/OIDC), SCIM provisioning, role-based permissions. |
| FR-SEC.6 | P1 | Retention policies with automatic expiry and hard delete (including derived artifacts and search index entries). |
| FR-SEC.7 | P1 | Recording-consent indicator visible to anyone whose screen or audio is being captured, on platforms that permit it. |
| FR-SEC.8 | P2 | C2PA-style provenance metadata distinguishing captured pixels from AI-generated or AI-edited regions. |
| FR-SEC.9 | P2 | Per-viewer watermarking for leak attribution. |

**Acceptance — FR-SEC.2**
```
GIVEN a recording during which the user types into an <input type="password">
WHEN the state layer is inspected by any means, including raw file access
THEN no keystroke values from that field appear in input_events, DOM snapshot, HAR, or transcript
AND the event is present as {type: "input", target_role: "textbox", value_redacted: true}
```

---

## 7. Data contracts

### DC-4 — Capture sidecar schema (v1)

```jsonc
{
  "schema_version": "1.0",
  "capture_id": "cap_01HZ...",           // ULID
  "kind": "screenshot | recording | guide",
  "created_at": "2026-08-28T14:03:11.204Z",
  "duration_ms": 612340,                  // null for screenshots
  "surface": {
    "type": "browser | desktop | mobile_emulator | headless",
    "app": "Google Chrome",
    "url": "https://app.example.com/checkout",
    "os": "macOS 15.2",
    "locale": "en-US",
    "viewport": { "w": 1512, "h": 856, "dpr": 2 },
    "displays": [{ "id": "d1", "bounds": [0,0,3024,1712], "dpr": 2 }]
  },
  "pixel_layer": {
    "frames": [{ "t_ms": 0, "path": "frames/000000.png", "sha256": "..." }],
    "video": { "path": "video.mp4", "codec": "h264", "fps": 30 },
    "audio_tracks": [{ "kind": "mic", "path": "mic.aac" }]
  },
  "state_layer": {
    "dom_snapshot": { "t_ms": 0, "path": "dom/000000.json" } | null,
    "accessibility_tree": { "t_ms": 0, "path": "ax/000000.json" } | null,
    "console_log": [
      { "t_ms": 4120, "level": "error", "message": "...", "stack": "..." }
    ],
    "network_har": { "path": "network.har", "truncated": false } | null,
    "input_events": [
      {
        "t_ms": 5310,
        "type": "click | keydown | scroll | navigate | resize",
        "coordinates": { "x": 402, "y": 611 },
        "target": {
          "role": "button",
          "accessible_name": "Save changes",
          "text": "Save",
          "bounds": [380, 596, 120, 36],
          "selectors": [
            { "strategy": "testid", "value": "[data-testid=\"save\"]", "stability": 0.95 },
            { "strategy": "role_name", "value": "role=button[name=\"Save changes\"]", "stability": 0.80 },
            { "strategy": "css", "value": "form.settings > button.primary", "stability": 0.45 }
          ]
        },
        "value_redacted": false
      }
    ],
    "agent_trace": [
      {
        "t_ms": 5120,
        "agent_id": "agt_7",
        "tool": "browser.click",
        "arguments": { "selector": "[data-testid=\"save\"]" },
        "result": "ok",
        "reasoning_summary": "Submitting the settings form."
      }
    ],
    "unavailable": [{ "source": "dom_snapshot", "reason": "unsupported_surface" }]
  },
  "derived": {
    "transcript": { "path": "transcript.json" },
    "ocr": { "path": "ocr.json" },
    "summary": "User updates notification settings and hits a 500 on save.",
    "tags": ["settings", "error", "checkout"]
  },
  "redactions": [
    { "region": [100, 200, 240, 20], "kind": "pixelate", "reason": "email_detected", "applied_to": ["pixel", "dom", "ocr"] }
  ],
  "provenance": { "ai_edited_regions": [], "generator": "aperture/1.0.0" }
}
```

### DC-5 — Guide schema (v1)

```jsonc
{
  "schema_version": "1.0",
  "guide_id": "gde_01HZ...",
  "source_capture_id": "cap_01HZ...",
  "title": "How to update notification settings",
  "version": 3,
  "steps": [
    {
      "step_id": "stp_1",
      "index": 1,
      "text": "Click **Settings** in the sidebar.",
      "alt_text": "Screenshot of the app sidebar with the Settings item highlighted.",
      "image": { "path": "steps/001.png", "sha256": "..." },
      "annotations": [{ "kind": "badge", "number": 1, "anchor": { "selector": "[data-testid=\"nav-settings\"]" } }],
      "source": { "t_ms": 5310, "input_event_index": 4 },
      "target_selectors": [ /* ranked, as DC-4 */ ],
      "health": "ok | changed | broken",
      "last_verified_at": "2026-08-28T14:03:11.204Z"
    }
  ]
}
```

### DC-6 — Compatibility rules

- `schema_version` is semver. Additive fields are minor; removals or type changes are major.
- Consumers must ignore unknown fields.
- The sidecar is written **once**, atomically, alongside the media. Post-hoc mutation (redaction, healing) creates a new revision with a `supersedes` pointer; it never edits in place.

---

## 8. Non-functional requirements

| ID | Pri | Requirement |
|---|---|---|
| NFR-1 | P0 | p95 hotkey-to-capture-ready < 800 ms; p99 < 1500 ms. |
| NFR-2 | P0 | < 12% CPU on baseline hardware (2021 8-core laptop) during 1080p60 screen recording with hardware encoding. |
| NFR-3 | P0 | Idle memory footprint < 250 MB with ring buffer disabled. |
| NFR-4 | P0 | Offline-capable: capture, annotate, and export with no network. Sync on reconnect with conflict-free merge. |
| NFR-5 | P0 | Data at rest encrypted (AES-256); in transit TLS 1.3. |
| NFR-6 | P1 | State layer overhead < 15% of total artifact size for a typical 5-minute recording. |
| NFR-7 | P1 | MCP tool responses p95 < 2 s for cached captures, < 10 s for cold. |
| NFR-8 | P1 | 99.9% availability for share-link serving. |
| NFR-9 | P1 | Full keyboard operability of every capture and annotation action. |
| NFR-10 | P2 | SOC 2 Type II; GDPR data-subject export and erasure endpoints. |

## 9. Platform matrix

| Surface | M1 | GA | Notes |
|---|---|---|---|
| macOS (Apple Silicon + Intel) | ✅ | ✅ | ScreenCaptureKit; AX API for structured capture |
| Windows 11 | — | ✅ | Windows.Graphics.Capture; UIAutomation |
| Linux (Wayland + X11) | — | ✅ | PipeWire portal; AT-SPI |
| Chrome/Edge extension | ✅ | ✅ | Source of truth for DOM + HAR + console |
| Firefox extension | — | P2 | |
| Web app (view/edit/share) | ✅ | ✅ | |
| CLI | — | ✅ | |
| MCP server | ✅ | ✅ | Ships in M1 — it is the differentiator, not a follow-on |
| iOS / Android capture | — | P2 | |

## 10. Integrations

**P0:** Slack, GitHub Issues, clipboard/file system.
**P1:** Jira, Azure DevOps, Linear, Zendesk, Confluence, Notion, Figma, VS Code extension, generic webhook, public REST API.
**P2:** Intercom, Teams, JetBrains, SCORM export, Google Docs live embed.

Integration requirement `FR-INT.1` (P1): when filing to an issue tracker, attach the image **and** a distilled state-layer excerpt (console errors, failing network calls, target selector, environment) as a formatted comment — not just the media.

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| DOM snapshots leak secrets that pixel redaction would have caught | High / security | DC-3 transactional redaction; FR-SEC.2 secret suppression; ship a redaction test suite as a release gate |
| State layer bloats artifact size and cost | Medium | NFR-6 budget; body caps; field projection in FR-AGT.2; tiered retention for HAR |
| Auto-heal (FR-GDE.6) produces confidently wrong guides | High / trust | Never auto-publish a healed step; `health: changed` requires human confirmation before it enters an export |
| Record-to-test emits brittle scripts, poisoning trust | Medium | Ranked selectors with stability scores; refuse to emit an assertion below a confidence floor; mark low-confidence lines with a TODO comment |
| OS capture-permission friction on macOS/Wayland | Medium | First-run permission flow with explicit recovery path (see PRD-002 §4) |
| Agent trace ingestion becomes an unbounded firehose | Medium | Rate limit; cap trace size per recording; drop `reasoning_summary` first under pressure |

## 12. Build order

### M1 — Capture core + state layer + MCP (the wedge)
`FR-CAP.1-5`, `FR-REC.1-4`, `FR-STA.1-4`, `FR-ANN.1-3`, `FR-SHR.1-2`, `FR-SEC.1-4`, `FR-AGT.1-3`, `DC-4`.
**DoD:** A Claude Code agent can, over MCP, request a capture of a running web app, receive the image plus a schema-valid state layer, and answer a question about the UI that could not be answered from pixels alone. Redaction test suite green. NFR-1, NFR-2, NFR-3, NFR-5 met.

### M2 — Guides + AI
`FR-GDE.1-4`, `FR-AI.1-3`, `FR-ANN.4-7`, `FR-REC.5-8`, `DC-5`.
**DoD:** A 15-step guide is generated from a single recording, exported to Markdown and HTML with alt text, and contains zero unredacted PII from a seeded PII test fixture.

### M3 — Agent loop closure
`FR-AGT.4-7`, `FR-GDE.5-6`, `FR-CLI.1-3`, `FR-STA.5-7`, `FR-AI.4-7`.
**DoD:** Record-to-test emits a green Playwright script on the reference app. Auto-heal satisfies its acceptance criteria on the reference guide. CI diff gate blocks a seeded visual regression.

### M4 — Scale, governance, breadth
`FR-SHR.3-5`, `FR-SEC.5-7`, `FR-INT.1`, Windows and Linux parity, remaining P1s.
**DoD:** Platform matrix GA column complete. SSO/SCIM functional. Audit log queryable.

### Post-GA — P2 backlog
All P2 items, in the order they are pulled by demand.

## 13. Open questions

| # | Question | Owner | Needed by |
|---|---|---|---|
| Q1 | Does the state layer get its own retention policy, separate from media? (It is smaller but more sensitive.) | Security | M1 |
| Q2 | Do we store DOM snapshots for *every* frame of a recording, or on interaction boundaries only? Proposal: interaction boundaries + 1 Hz keyframe. | Eng | M1 |
| Q3 | Is agent_trace ingested push (agent calls us) or pull (we scrape a trace file)? Proposal: push, with a pull fallback. | Eng | M3 |
| Q4 | Pricing unit — per seat, per capture, or per GB of state layer? | Product | GA |
| Q5 | Do we expose the MCP server locally (stdio) as well as remotely (HTTP/SSE)? Proposal: both; local-only mode requires stdio. | Eng | M1 |

## 14. Glossary

- **Pixel layer** — the visual output: frames, video, audio.
- **State layer** — the timestamp-aligned structured record of what the screen actually contained.
- **Sidecar** — the JSON file carrying the state layer alongside the media (DC-4).
- **Auto-heal** — re-capturing only the changed steps of an existing guide against a new build.
- **Record-to-test** — emitting a runnable automation script from a recorded human session.
- **Agent trace** — a stream of an autonomous agent's tool calls, aligned to a recording's timeline.
