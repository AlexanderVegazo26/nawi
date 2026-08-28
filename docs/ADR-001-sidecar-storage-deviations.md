# ADR-001 — Deliberate deviations from DC-4's literal sidecar shape

- **Status:** Accepted
- **Date:** 2026-08-28
- **Milestone:** M1a (state layer)
- **Applies to:** `src/shared/sidecar/**`, `src/main/sidecar/**`, `library.ts`'s sidecar API
- **Authority:** `docs/PRD-001-core-capture-platform.md` §5 (DC-1/2/3), §7 (DC-4, DC-6), §6.3 (FR-STA), §6.6 (FR-AGT)

DC-4 is a *schema sketch* inside a PRD, not a wire format we owe another
implementation byte-compatibility with. Three of its details do not survive
contact with requirements stated elsewhere in the same document. Each deviation
below is recorded with what it costs, because a future reader comparing the code
to §7 will otherwise assume the code is simply wrong.

---

## 1. `console_log` and `input_events` are NDJSON side files, not inline arrays

**DC-4 literally says:**

```jsonc
"console_log": [ { "t_ms": 4120, "level": "error", "message": "...", "stack": "..." } ],
"input_events": [ { "t_ms": 5310, "type": "click", … } ]
```

**We write:**

```jsonc
"console_log":  { "path": "console.ndjson", "count": 412 },
"input_events": { "path": "input_events.ndjson", "count": 1908 }
```

### Why

FR-AGT.2 requires an agent to answer a *filtered* query — "the error-level console
entries from this capture" — inside a **32 KB** response budget. FR-STA.3 requires
console capture across an entire recording plus 30 s of preamble, and FR-STA.4
requires every input event with its ranked selector array. A 30-minute session
plausibly produces tens of megabytes of those two arrays.

Inline, answering that query means `JSON.parse`-ing the whole sidecar. A 40 MB
parse to emit 32 KB is not a performance nit — it makes the sidecar unusable for
the exact job the state layer exists for, and it violates DC-4's own framing that
the sidecar root is small and cheaply parseable. It also degrades every unrelated
read (the MCP `list_captures` path, the library UI) to the size of the noisiest
capture in the store.

The side-file form is not an invention: DC-4 already uses `{path}` refs for
`dom_snapshot`, `accessibility_tree` and `network_har` — the three payloads whose
size was obvious at authoring time. Console and input streams belong in the same
category; NDJSON additionally lets a reader stream and filter line-by-line
without holding the file in memory. `count` is carried alongside the path so a
consumer can size a query before opening anything.

### What it costs, and the mitigation

An externally-authored, strictly-conformant DC-4 sidecar carries the inline form
and must still load. So the **read** parser (`SidecarLoose`) accepts
`NdjsonRef | Entry[] | null` on both fields, and the read type (`SidecarRead`)
models that union honestly rather than lying to callers. Only the **write** path
(`SidecarStrict`) is narrowed to the ref form: one shape on disk, ours.

`isNdjsonRef()` in `src/shared/sidecar/types.ts` is the narrowing helper for
consumers of the union.

---

## 2. `capture_id` is a `randomUUID()`, not a ULID

**DC-4 says** `"capture_id": "cap_01HZ..." // ULID`.

`src/main/library.ts`'s `UUID_RE` is not a formatting preference — it is the
path-traversal control that makes it safe to turn an id that arrived over IPC
into a directory name. Widening it to admit ULIDs (or to admit a `cap_` prefix)
would weaken a security control to satisfy an example in a schema comment.

The id is opaque to every consumer: nothing in the PRD sorts by it, and DC-4 does
not require lexicographic-by-time ordering — `created_at` carries that. So the
deviation costs nothing except literal string-shape conformance, and the same
anchored regex now guards the sidecar store (`src/main/sidecar/paths.ts`).

If a ULID is ever genuinely required, the change is to add a *second*, equally
anchored pattern — never to relax the existing one.

---

## 3. A revision owns a directory: `captures/<id>/v<N>/sidecar.v<N>.json`

> **This one resolves a self-inconsistent instruction**, not a preference. The
> M1a brief asked for both `captures/<uuid>/sidecar.v<N>.json` with sibling asset
> directories *and* "a single `fs.rename` of the directory into place". Those two
> cannot both hold. It was resolved toward the DC-3/DC-6 invariants; the
> alternative is a one-line change to the path helpers if a reviewer prefers the
> flat shape and accepts the consequences below.

**The M1a plan sketched:**

```
captures/<uuid>/
  sidecar.v1.json
  sidecar.v2.json
  dom/  ax/  network.har  console.ndjson  input_events.ndjson
```

**We write:**

```
captures/<uuid>/
  v1/  sidecar.v1.json  dom/  ax/  network.har  console.ndjson  input_events.ndjson
  v2/  sidecar.v2.json  …                    # supersedes "v1"
  .tmp-v3/                                    # a crashed write; invisible to readers
```

### Why

**The decisive reason is DC-6, not atomicity.** In the flat sketch, `dom/`, `ax/`,
`network.har`, `console.ndjson` and `input_events.ndjson` sit at the *capture*
root and are therefore shared by every revision. A v2 that re-harvests the DOM —
which is exactly what a heal does — has to write `dom/000000.json` over v1's copy.
That is in-place mutation of a superseded revision's data, which DC-6 forbids in
so many words ("it never edits in place"), and it silently falsifies v1's own
sidecar, whose `path` now resolves to different bytes. The flat layout cannot
represent a revision that carries new side files at all.

Giving each revision a directory makes the prior revision's bytes unreachable by
construction: nothing ever opens `v1/` again. The filesystem enforces DC-6 rather
than developer discipline.

Secondarily, it makes the publish a single `fs.rename`. The flat layout *can* be
made crash-safe with two renames ordered assets-first (a crash between them leaves
the sidecar file absent, so the revision is invisible and the prior one intact) —
so atomicity alone would not have justified the change. One rename is simply the
smaller thing to reason about, and it removes the ordering constraint entirely.

### Crash semantics this buys

| Crash point | On-disk result | Visible to `listRevisions` | Resolved by `readSidecar(id)` |
|---|---|---|---|
| During staging | `.tmp-v<N>/` | No — not a revision name | No |
| After `rename`, before index write | complete `v<N>/` | **Yes** — it genuinely exists | **No** — the index still points at `v<N-1>` |
| After index write | complete `v<N>/` | Yes | Yes |

The middle row is the deliberate split: `listRevisions` reports what is on disk
(an auditor needs to see an orphan), while `readSidecar` with no explicit
revision resolves through `LibraryItem.sidecarRevision`, so an orphan is inert
rather than silently becoming current. `saveSidecarRevision` computes the next
number from `max(on-disk, index) + 1`, so an orphan can never be overwritten and
a number is never reused.

---

## 4. Related decision, not a deviation: two parsers over one shape

`SidecarStrict` (`.strict()`) on write, `SidecarLoose` (`.passthrough()`) on read.

DC-6 requires consumers to **ignore** unknown fields, and zod's default behaviour
is to **strip** them — an older build round-tripping a newer file would silently
delete data. Looseness has to be applied at *every* nesting level, not just the
root, so both parsers are generated from one shape factory and cannot drift.

`readRevision` belts that brace by returning the raw `JSON.parse` result after
validation, making preservation a property of our code rather than of zod's
catchall semantics. `STRICT_SCHEMA_MATCHES_TYPES` in `schema.ts` is a
compile-time `Equals<>` assertion that the zod schema and the hand-written types
have not drifted.

---

## Consequences

- Anything reading a sidecar must handle `console_log`/`input_events` as a union.
  `SidecarRead` makes that a compile error rather than a runtime surprise.
- `zod` moves to `dependencies` (not `devDependencies`): `externalizeDepsPlugin()`
  is on for main, so a runtime import must ship in the asar. The renderer imports
  `src/shared/sidecar/types.ts` with `import type` only, so it stays out of the
  web bundle.
- A future major schema change writes `2.0` and gets a new reader; `checkCompatibility`
  already refuses to guess at a different major.
