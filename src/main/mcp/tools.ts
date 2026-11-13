import { app, screen } from 'electron'
import { z } from 'zod'
import { join } from 'node:path'
import * as library from '../library'
import * as capture from '../capture'
import { createDraft, markUnavailable, addAgentTrace } from '@shared/sidecar/draft'
import { seal } from '../sidecar/seal'
import * as settings from '../settings'
import type { Surface } from '@shared/sidecar/types'
import type { AnnotationDoc, LibraryItem, Shape } from '@shared/types'
import { defineTool, type ToolDefinition } from './dispatch'
import { stepProgress } from './progress'
import { ToolError, agentAccessPaused, notImplemented } from './errors'
import { PROJECTABLE_FIELDS, project, MAX_RESPONSE_BYTES } from './projection'
import { flowFromSidecar, NoInputEventsError, prepareFlowOutput, writeFlowOutput } from './flow-export'
import { carryForwardFiles } from './revision'
import { androidReplayOf, MAX_FLOW_PATH, resolveFlowFile, runFlowFile } from '../flow-run'
import { healProposals, readRunFlow } from '../heal/proposals'
import { applyHeal } from '../heal/apply'
import { DEFAULT_KEEP_RUNS, RUN_ID_RE, listRuns, newRunId, pruneRuns, readRunRecord } from '../run-record'
import { REVISION_RE } from '../sidecar/paths'
import { inspectApkFile } from '../mobile/apk'
import { ApkError } from '../mobile/errors'
import { runMobileDoctor } from '../mobile/doctor'
import { MAX_ONBOARDING_ENTRIES, mergeOnboarding } from '../mobile/onboarding'
import { openApp, runtimePermissionsFor, type OpenStepId } from '../mobile/open'
import {
  PACKAGE_RE,
  ProfileFileError,
  TARGET_RE,
  defaultProfilePath,
  isProfilePath,
  readProfileFile,
  sha256File,
  writeProfileFile,
  type MobileProfile
} from '../mobile/profile'
import { realpath } from 'node:fs/promises'
import { DEFAULT_KEEP_STUDIES, studyLiveScreen, writeStudy } from '../mobile/study-live'
import { DEFAULT_KEEP_EXPLORATIONS, MAX_NEVER_PRESS_WORDS, NEVER_PRESS_WORD_RE, discardExploration, exploreLiveApp, screenshotSpool, writeExploration } from '../mobile/explore-live'
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_SCREENS, DEFAULT_MAX_TAPS, DEFAULT_TIME_BUDGET_MS } from '../mobile/explore'
import { DEFAULT_IDLE_MS, DEFAULT_MAX_MS, recordAndroidLive } from '../mobile/record-live'

/**
 * The twelve FR-AGT.1 tools.
 *
 * **The rule that shapes this file:** where a capability does not exist in this
 * build, the tool returns a typed error *and says so in its description* — it
 * never returns a plausible-looking success. An agent told `ok` for a redaction
 * that did not happen will go on to share the artifact. That failure is silent,
 * arrives late, and is a P0 security bug (DC-3); a `NOT_IMPLEMENTED` costs the
 * agent one turn and is recoverable.
 *
 * Tool bodies are never called directly — `dispatch()` is the only caller, which
 * is what makes the UX-AGT.3 kill switch, the bearer check and validation
 * unskippable. Arguments arriving here are already schema-validated.
 */

const GENERATOR = `nawi/${app.getVersion?.() ?? '0.1.0'}`

/** Shared by every tool that can meaningfully be replayed (FR-AGT.3). */
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('Repeat a call with the same key to get the first call\'s capture_id back instead of capturing again.')

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** The public shape of a capture. Absolute paths are deliberately not exposed. */
function itemView(item: LibraryItem): Record<string, unknown> {
  return {
    capture_id: item.id,
    name: item.name,
    kind: item.kind,
    capture_kind: item.captureKind,
    width: item.width,
    height: item.height,
    size_bytes: item.size,
    duration_ms: item.durationMs,
    created_at: item.createdAt,
    has_annotations: item.annotations !== null,
    sidecar_revision: item.sidecarRevision ?? null,
    tags: item.tags ?? [],
    source: item.source ?? 'user',
    /** FR-AGT.2's link form, so an agent can seek straight to the asset. */
    asset_url: `capture://asset/${item.id}`
  }
}

/** An unknown display id is the caller's mistake: NOT_FOUND, not an INTERNAL "retry may help". */
function displayFor(displayId?: number): Electron.Display {
  if (typeof displayId !== 'number') return screen.getPrimaryDisplay()
  const found = screen.getAllDisplays().find((d) => d.id === displayId)
  if (!found) throw new ToolError('NOT_FOUND', `No display with id ${displayId}.`, { display_id: displayId })
  return found
}

/**
 * Builds the surface block for a *desktop* capture.
 *
 * DC-2's own worked example is exactly this case: a native grab has no DOM, so
 * the sidecar records `dom_snapshot: null` plus a matching `unavailable` reason
 * rather than omitting the key.
 */
function desktopSurface(display: Electron.Display): Surface {
  return {
    type: 'desktop',
    app: 'Nawi',
    url: null,
    os: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim(),
    locale: app.getLocale() || 'en-US',
    viewport: {
      w: Math.round(display.bounds.width * display.scaleFactor),
      h: Math.round(display.bounds.height * display.scaleFactor),
      dpr: display.scaleFactor
    },
    displays: capture.listDisplays().map((d) => ({
      id: String(d.id),
      bounds: [d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height] as [
        number,
        number,
        number,
        number
      ],
      dpr: d.scaleFactor
    }))
  }
}

/**
 * Writes the v1 sidecar for a freshly-taken agent capture.
 *
 * Every state-layer source is marked unavailable with `unsupported_surface`,
 * which is the truth: this is a native desktop grab and the CDP harvester is not
 * attached. DC-2 requires that this be *stated*, not implied by an absent key —
 * so `get_state_layer` on an agent capture returns a well-formed answer that
 * says "there is no DOM here and here is why", rather than a 404.
 *
 * A sidecar failure must not lose the capture: the pixels are already on disk
 * and the item is already in the index, so this is best-effort and reports what
 * happened instead of unwinding a successful capture.
 *
 * The draft goes through `seal()` — the FR-SEC.2 chokepoint — rather than
 * straight to the store, so an agent capture is scanned by the same Tier-B pass
 * as a harvested one. Nothing here can leak today (the state layer is entirely
 * empty), but a second unscanned writer is exactly how that stops being true.
 *
 * SEAM to reconcile with the parallel M1a workstream: `writeSealedRevision`
 * publishes the revision directory but does not flip the library index's
 * `sidecarRevision` pointer, and `library.saveSidecarRevision` owns both that
 * pointer and the serialized transaction chain. So the sealed sidecar is handed
 * to `library`, not to `writer.ts`. Whoever unifies those two write paths should
 * make `library.saveSidecarRevision` accept only a `SealedSidecar`, which would
 * make the chokepoint compiler-enforced here too.
 */
async function writeAgentSidecar(
  item: LibraryItem,
  display: Electron.Display,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ revision: string | null; error: string | null }> {
  try {
    const draft = createDraft({
      capture_id: item.id,
      kind: 'screenshot',
      surface: desktopSurface(display),
      created_at: item.createdAt,
      generator: GENERATOR
    })
    for (const source of [
      'dom_snapshot',
      'accessibility_tree',
      'console_log',
      'network_har',
      'input_events'
    ] as const) {
      markUnavailable(draft, source, 'unsupported_surface')
    }
    // FR-AGT.6 / UX-AGT.2: the capture records which tool call produced it.
    addAgentTrace(draft, {
      t_ms: 0,
      agent_id: 'mcp',
      tool: toolName,
      arguments: args,
      result: 'ok',
      reasoning_summary: null
    })
    // Tier B. Workspace rules are additive on top of the built-in FR-AI.3 set;
    // they cannot disable it.
    const { redactionRules } = await settings.getSettings()
    const sealedRevision = seal(draft, [], { rules: redactionRules })
    if (sealedRevision.report.tierAFailures.length > 0) {
      // A Tier-B hit on a value Tier A claimed to suppress means ingest leaked.
      // Loud, because the whole point of the second tier is that reaching it is
      // a failure and not a save.
      console.error(
        '[mcp] SEAL: Tier-A leak detected while writing an agent sidecar',
        sealedRevision.report.tierAFailures
      )
    }
    const saved = await library.saveSidecarRevision(item.id, sealedRevision.sidecar)
    return { revision: saved.revision, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Reported, never swallowed: the caller surfaces it on the tool result so a
    // missing state layer is visible rather than mysterious.
    console.error('[mcp] sidecar write failed', message)
    return { revision: null, error: message }
  }
}

async function requireItem(captureId: string): Promise<LibraryItem> {
  const item = await library.getItem(captureId)
  if (!item) {
    throw new ToolError('NOT_FOUND', `No capture with id ${captureId}`, { capture_id: captureId })
  }
  return item
}

/* ------------------------------------------------------------------ *
 * Capture tools
 * ------------------------------------------------------------------ */

const captureScreen = defineTool({
  name: 'capture_screen',
  description:
    'Capture a full display as a PNG and store it in the Nawi library. Returns a stable capture_id. ' +
    'Pass idempotency_key to make retries safe: the same key returns the first call\'s capture_id without capturing again.',
  idempotent: true,
  errors: ['NOT_FOUND'],
  schema: z.object({
    display_id: z
      .number()
      .int()
      .optional()
      .describe('Electron display id from list_captures/displays. Defaults to the primary display.'),
    name: z.string().min(1).max(200).optional(),
    idempotency_key: idempotencyKey
  }),
  async run(args) {
    const display = displayFor(args.display_id)
    const img = await capture.captureDisplay(display)
    const size = img.getSize()
    const item = await library.save({
      kind: 'image',
      captureKind: 'fullscreen',
      bytes: Buffer.from(img.toPNG()),
      width: size.width,
      height: size.height,
      name: args.name
    })
    const sidecar = await writeAgentSidecar(item, display, 'capture_screen', { ...args })
    return { ...itemView(item), sidecar_revision: sidecar.revision, sidecar_error: sidecar.error }
  }
})

const captureRegion = defineTool({
  name: 'capture_region',
  description:
    'Capture a rectangular region of a display as a PNG. Coordinates are in that display\'s own DIP space ' +
    '(top-left origin), and are converted to physical pixels and clamped to the display. Returns a stable capture_id.',
  idempotent: true,
  errors: ['NOT_FOUND'],
  schema: z.object({
    x: z.number().int().min(0).max(100_000),
    y: z.number().int().min(0).max(100_000),
    width: z.number().int().min(1).max(100_000),
    height: z.number().int().min(1).max(100_000),
    display_id: z.number().int().optional(),
    name: z.string().min(1).max(200).optional(),
    idempotency_key: idempotencyKey
  }),
  async run(args) {
    const display = displayFor(args.display_id)
    const img = await capture.captureDisplay(display)
    const bitmap = img.getSize()
    // The one conversion that must never be inlined — see capture.ts's note on
    // DIP vs physical pixels at fractional scale factors.
    const rect = capture.dipRectToPixels(
      { x: args.x, y: args.y, width: args.width, height: args.height },
      display,
      bitmap
    )
    if (rect.width < 1 || rect.height < 1) {
      throw new ToolError(
        'INVALID_ARGUMENTS',
        'That region is empty once clamped to the display. Check the coordinates against list_displays.',
        { requested: args, display_pixels: bitmap }
      )
    }
    const cropped = img.crop(rect)
    const size = cropped.getSize()
    const item = await library.save({
      kind: 'image',
      captureKind: 'region',
      bytes: Buffer.from(cropped.toPNG()),
      width: size.width,
      height: size.height,
      name: args.name
    })
    const sidecar = await writeAgentSidecar(item, display, 'capture_region', { ...args })
    return { ...itemView(item), sidecar_revision: sidecar.revision, sidecar_error: sidecar.error }
  }
})

const captureElement = defineTool({
  name: 'capture_element',
  description:
    'Capture a single DOM element by selector, with its state layer. NOT AVAILABLE in this build: it requires a ' +
    'browser attached over CDP, which this build cannot do yet. It fails with NO_BROWSER_ATTACHED rather than ' +
    'falling back to a screen grab — a full-screen image returned in place of one element is both wrong and a ' +
    'confidentiality problem, since it captures everything else on screen too.',
  idempotent: true,
  errors: ['NO_BROWSER_ATTACHED'],
  schema: z.object({
    selector: z.string().min(1).max(2000),
    idempotency_key: idempotencyKey
  }),
  async run(args) {
    // Deliberately no fallback, for the same reason index.ts's display-media
    // handler refuses to substitute a different source: silently capturing
    // something other than what was asked for is worse than failing.
    throw new ToolError(
      'NO_BROWSER_ATTACHED',
      'No browser is attached, so the element could not be located. Element-aware capture needs a Chrome ' +
        'target attached over CDP. No capture was created, and no full-screen fallback was taken.',
      { selector: args.selector }
    )
  }
})

/* ------------------------------------------------------------------ *
 * Recording tools
 * ------------------------------------------------------------------ */

const RECORDING_UNAVAILABLE =
  'recording is driven by MediaRecorder in the renderer and has no main-process entry point yet, so an agent ' +
  'cannot start or stop one without a user picking a source. This lands with the M1b recorder rebuild.'

const startRecording = defineTool({
  name: 'start_recording',
  description: `Start a screen recording. NOT AVAILABLE in this build: ${RECORDING_UNAVAILABLE}`,
  idempotent: true,
  errors: ['NOT_IMPLEMENTED'],
  schema: z.object({
    display_id: z.number().int().optional(),
    audio: z.boolean().optional(),
    idempotency_key: idempotencyKey
  }),
  run: async () => {
    throw notImplemented('start_recording', RECORDING_UNAVAILABLE)
  }
})

const stopRecording = defineTool({
  name: 'stop_recording',
  description: `Stop the current recording and store it. NOT AVAILABLE in this build: ${RECORDING_UNAVAILABLE}`,
  idempotent: true,
  errors: ['NOT_IMPLEMENTED'],
  schema: z.object({ idempotency_key: idempotencyKey }),
  run: async () => {
    throw notImplemented('stop_recording', RECORDING_UNAVAILABLE)
  }
})

/* ------------------------------------------------------------------ *
 * Read tools
 * ------------------------------------------------------------------ */

const getCapture = defineTool({
  name: 'get_capture',
  description:
    'Metadata for one capture by id: dimensions, kind, timestamps, sidecar revision, and a capture:// asset URL. ' +
    'Does not return image bytes — use the asset_url.',
  idempotent: false,
  errors: ['NOT_FOUND'],
  schema: z.object({ capture_id: z.string().min(1).max(200) }),
  async run(args) {
    return itemView(await requireItem(args.capture_id))
  }
})

const getStateLayer = defineTool({
  name: 'get_state_layer',
  description:
    'Read a capture\'s DC-4 state layer with field projection, filtering and pagination. The response is hard-capped ' +
    `at ${MAX_RESPONSE_BYTES} bytes: entries are emitted until the budget is spent, then next_cursor and truncated ` +
    'are returned — pass the cursor back to continue. Every entry keeps its t_ms and carries a seekable video_url. ' +
    'A source that was never harvested is reported as unavailable with a reason, not omitted. A side file that ' +
    'fails to read (missing, I/O error) sets read_error to the error code on its field, after the entries read before it.',
  idempotent: false,
  errors: ['NOT_FOUND', 'UNAVAILABLE'],
  schema: z.object({
    capture_id: z.string().min(1).max(200),
    revision: z.string().max(16).regex(REVISION_RE, 'a revision such as "v1"').optional().describe('e.g. "v1". Defaults to the current revision.'),
    fields: z.array(z.enum(PROJECTABLE_FIELDS)).max(16).optional(),
    level: z.array(z.enum(['log', 'info', 'warn', 'error', 'debug'])).max(8).optional(),
    type: z.array(z.enum(['click', 'keydown', 'scroll', 'navigate', 'resize'])).max(8).optional(),
    cursor: z.string().max(128).nullish(),
    max_bytes: z.number().int().min(1024).max(MAX_RESPONSE_BYTES).optional()
  }),
  async run(args) {
    const item = await requireItem(args.capture_id)
    const sidecar = await library.readSidecar(args.capture_id, args.revision)
    if (!sidecar) {
      // DC-2 in spirit: say why there is nothing, rather than 404-ing and
      // leaving the agent to guess whether the capture or the data is missing.
      throw new ToolError(
        'UNAVAILABLE',
        'That capture has no state layer. It was taken before a sidecar was harvested for it.',
        { capture_id: item.id, has_sidecar: false }
      )
    }
    const revision = args.revision ?? item.sidecarRevision
    if (!revision || !item.sidecarDir) {
      throw new ToolError('UNAVAILABLE', 'That capture has no resolvable sidecar revision.', {
        capture_id: item.id
      })
    }
    return project({
      revisionDir: join(item.sidecarDir, revision),
      sidecar,
      query: args
    })
  }
})

const listCaptures = defineTool({
  name: 'list_captures',
  description:
    'List captures, newest first, with offset/limit paging. Optionally filter by kind or by source (user vs agent).',
  idempotent: false,
  errors: [],
  schema: z.object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).max(1_000_000).default(0),
    kind: z.enum(['image', 'video', 'guide']).optional(),
    source: z.enum(['user', 'agent']).optional()
  }),
  async run(args) {
    let items = await library.listItems()
    if (args.kind) items = items.filter((i) => i.kind === args.kind)
    if (args.source) items = items.filter((i) => (i.source ?? 'user') === args.source)
    const page = items.slice(args.offset, args.offset + args.limit)
    return {
      total: items.length,
      offset: args.offset,
      limit: args.limit,
      captures: page.map(itemView),
      next_offset: args.offset + page.length < items.length ? args.offset + page.length : null
    }
  }
})

const searchCaptures = defineTool({
  name: 'search_captures',
  description:
    'Substring search over capture names and tags, newest first. This is a literal match, not semantic search ' +
    '(FR-AI.5) — it does not search transcripts, OCR text or DOM text, because none of those are indexed yet.',
  idempotent: false,
  errors: [],
  schema: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(100).default(25)
  }),
  async run(args) {
    const needle = args.query.toLowerCase()
    const items = await library.listItems()
    const hits = items.filter(
      (i) =>
        i.name.toLowerCase().includes(needle) ||
        (i.tags ?? []).some((t) => t.toLowerCase().includes(needle))
    )
    return {
      query: args.query,
      total: hits.length,
      // Stated plainly so an agent does not read an empty result as "no such
      // content exists" when it only means "the name did not match".
      searched: ['name', 'tags'],
      not_searched: ['transcript', 'ocr_text', 'dom_text'],
      captures: hits.slice(0, args.limit).map(itemView)
    }
  }
})

/* ------------------------------------------------------------------ *
 * Mutation tools
 * ------------------------------------------------------------------ */

const shapeSchema = z.object({
  kind: z.enum(['arrow', 'rect', 'ellipse', 'line', 'highlight']),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  strokeWidth: z.number().min(0.5).max(200)
})

const annotate = defineTool({
  name: 'annotate',
  description:
    'Add non-destructive annotation shapes to a capture (FR-ANN.2 — the original frame is always recoverable). ' +
    'Coordinates are in image-pixel space. Shapes are appended to any the user already drew. This also writes a ' +
    'NEW sidecar revision recording the agent trace; it never edits an existing revision in place (DC-6).',
  idempotent: true,
  errors: ['NOT_FOUND'],
  schema: z.object({
    capture_id: z.string().min(1).max(200),
    shapes: z.array(shapeSchema).min(1).max(100),
    idempotency_key: idempotencyKey
  }),
  async run(args, ctx) {
    const item = await requireItem(args.capture_id)
    const existing: AnnotationDoc = item.annotations ?? { version: 1, shapes: [], crop: null }
    const added: Shape[] = args.shapes.map((s, i) => ({
      ...s,
      id: `agent-${ctx.callId}-${i}`
    }))
    const updated = await library.saveAnnotations(item.id, {
      ...existing,
      shapes: [...existing.shapes, ...added]
    })

    // DC-6: a post-hoc change creates a new revision with a supersedes pointer.
    // `saveSidecarRevision` sets `supersedes` itself and leaves the prior file
    // byte-identical.
    //
    // Every referenced side file is copied into the new revision in the same
    // transaction. Nulling the refs instead would silently discard a harvested
    // state layer — the new revision becomes current, so `get_state_layer` would
    // report `console_log: null` afterwards with nothing reporting the loss —
    // and it would also violate DC-2, which the strict write-path schema does
    // NOT catch (it validates the shape of `unavailable[]`, not the cross-field
    // rule that a null source implies a matching entry; only `finalize()`
    // enforces that, and this path does not go through it).
    let revision: string | null = null
    let sidecarError: string | null = null
    const current = await library.readSidecar(item.id)
    if (current && item.sidecarDir && item.sidecarRevision) {
      try {
        const files = await carryForwardFiles(
          join(item.sidecarDir, item.sidecarRevision),
          current
        )
        const saved = await library.saveSidecarRevision(
          item.id,
          {
            ...current,
            // Refs are preserved exactly, which is only sound because `files`
            // republishes what they point at.
            state_layer: {
              ...current.state_layer,
              agent_trace: [
                ...current.state_layer.agent_trace,
                {
                  t_ms: 0,
                  agent_id: 'mcp',
                  tool: 'annotate',
                  arguments: { shape_count: added.length },
                  result: 'ok',
                  reasoning_summary: null
                }
              ]
            }
          } as Parameters<typeof library.saveSidecarRevision>[1],
          { files }
        )
        revision = saved.revision
      } catch (err) {
        // Reported on the tool result, never swallowed: the annotation itself
        // succeeded and is already persisted, so the caller must be able to see
        // that the sidecar half did not.
        sidecarError = err instanceof Error ? err.message : String(err)
        console.error('[mcp] annotate sidecar revision failed', sidecarError)
      }
    }

    return {
      ...itemView(updated),
      shapes_added: added.length,
      sidecar_revision: revision,
      sidecar_error: sidecarError
    }
  }
})

const redact = defineTool({
  name: 'redact',
  description:
    'Permanently remove a region from a capture. NOT AVAILABLE in this build. DC-3 requires the pixel redaction and ' +
    'the matching state-layer redaction to land in the same transaction, and this process cannot rasterize pixels — ' +
    'annotation flattening happens in the renderer. Recording a state-layer redaction alone would leave the app ' +
    'reporting a region as redacted while the original pixels are still in the exported PNG, which is exactly the ' +
    'P0 that DC-3 forbids. Use annotate for a visible marker that is honestly non-destructive.',
  idempotent: true,
  errors: ['NOT_FOUND', 'NOT_IMPLEMENTED'],
  schema: z.object({
    capture_id: z.string().min(1).max(200),
    region: z.object({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(1),
      height: z.number().int().min(1)
    }),
    kind: z.enum(['blur', 'pixelate', 'solid']).default('solid'),
    idempotency_key: idempotencyKey
  }),
  async run(args) {
    // Validate the target exists first, so an agent gets NOT_FOUND for a bad id
    // rather than a misleading NOT_IMPLEMENTED.
    await requireItem(args.capture_id)
    throw notImplemented(
      'redact',
      'no pixel rasterizer exists in the main process, and DC-3 forbids recording the state-layer half of a ' +
        'redaction without the pixel half in the same transaction. Nothing was changed.'
    )
  }
})

const exportGuide = defineTool({
  name: 'export_guide',
  description:
    'Export a recording as a step-by-step guide (Markdown or HTML). NOT AVAILABLE in this build: guide generation ' +
    '(FR-GDE) has not been built — there is no step extractor, no guide schema writer and no exporter. This lands in M2.',
  idempotent: true,
  errors: ['NOT_FOUND', 'NOT_IMPLEMENTED'],
  schema: z.object({
    capture_id: z.string().min(1).max(200),
    format: z.enum(['markdown', 'html']).default('markdown'),
    idempotency_key: idempotencyKey
  }),
  async run(args) {
    await requireItem(args.capture_id)
    throw notImplemented(
      'export_guide',
      'guide generation (FR-GDE.1-3) does not exist yet — there is no step extractor or exporter to run.'
    )
  }
})

/**
 * Roadmap F2: a recording's input events as a flow file. Derived on demand and
 * never written into the capture: a sealed sidecar revision never changes
 * (DC-6), and the flow a person edits belongs next to their other flows. With
 * `output` it is written there, with the steps' reference crops (roadmap AI1)
 * in a `<name>.crops/` folder next to it.
 */
const exportFlow = defineTool({
  name: 'export_flow',
  description:
    'Turn a browser recording\'s captured input events into an editable flow file (*.nawi.yaml, version 1): ' +
    'clicks, filled fields (one step per field, final value), choices in selects and named keys, each with its ' +
    'ranked selectors. Fields the app marked secret become ${secret.<name>} placeholders: their values were never ' +
    'recorded. Scrolls, resizes and modifier keys are left out and counted. Returns the YAML text; without output it ' +
    'writes nothing. With output (an absolute *.nawi.yaml path inside your home folder) it writes the flow there and ' +
    'each clicked element\'s reference crop next to it (<name>.crops/NNNNNN.png, as target.image), so replay can find ' +
    'an element by its look when its locators no longer match. An existing file is replaced only with overwrite: true.',
  idempotent: false,
  errors: ['NOT_FOUND', 'UNAVAILABLE'],
  schema: z.object({
    capture_id: z.string().min(1).max(200),
    revision: z.string().max(16).regex(REVISION_RE, 'a revision such as "v1"').optional().describe('e.g. "v1". Defaults to the current revision.'),
    name: z.string().max(200).optional().describe('Flow name. Defaults to "Recording <created_at>".'),
    output: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('Absolute path of the *.nawi.yaml file to write, inside your home folder; its crops go to <name>.crops/ next to it. Omit to only return the YAML.'),
    overwrite: z.boolean().default(false).describe('Replace an existing file at output (and the crops of an earlier export there).')
  }),
  async run(args) {
    const item = await requireItem(args.capture_id)
    const sidecar = await library.readSidecar(args.capture_id, args.revision)
    const revision = args.revision ?? item.sidecarRevision
    if (!sidecar || !revision || !item.sidecarDir) {
      throw new ToolError(
        'UNAVAILABLE',
        'That capture has no state layer, so there are no input events to turn into a flow.',
        { capture_id: item.id, has_sidecar: Boolean(sidecar) }
      )
    }
    try {
      return {
        capture_id: item.id,
        ...(await flowFromSidecar({
          revisionDir: join(item.sidecarDir, revision),
          sidecar,
          revision,
          name: args.name,
          ...(args.output !== undefined ? { output: args.output, overwrite: args.overwrite } : {})
        }))
      }
    } catch (err) {
      if (err instanceof NoInputEventsError) {
        throw new ToolError(
          'UNAVAILABLE',
          err.reason === 'unreadable'
            ? 'That capture\'s input events file is missing or unreadable, so no flow can be made from it.'
            : 'That capture has no input events (only browser recordings with state harvest have them).',
          { capture_id: item.id, reason: err.reason }
        )
      }
      throw err
    }
  }
})

/** Values a run takes from its caller: bounded, so one call cannot hand main megabytes of map. */
const inputMap = (what: string) =>
  z
    .record(z.string().min(1).max(100), z.string().max(10_000))
    .refine((m) => Object.keys(m).length <= 200, `at most 200 ${what}`)
    .optional()

/** Where saved runs live: one folder per run (see run-record.ts). */
export const runsDir = (): string => join(app.getPath('userData'), 'runs')

/**
 * Roadmap F3b: replay a flow file in a browser. The kill switch is checked by
 * dispatch before the run starts and watched while it runs: pausing agent
 * access stops the run after the step in progress.
 */
const runFlow = defineTool({
  name: 'run_flow',
  description:
    'Replay a flow file (*.nawi.yaml, absolute path inside your home directory) in a browser, or on an Android device for a flow with target.kind android, and report each ' +
    'step: passed/failed/skipped/not_run, its intent, the locator that matched (with its layer: testid/id/role/text/css, ' +
    'and fallback: true when a more stable locator found nothing, so the flow is drifting from the app), the ones that missed and why, timings, and ' +
    'what the page did meanwhile (the URL after the step, and its first 3 console errors and failed requests, ' +
    'with a count of the rest; the run record keeps up to 20 of each). ' +
    `Each run is saved as a run record (run_dir: run.json, junit.xml, report.html and step screenshots; the newest ${DEFAULT_KEEP_RUNS} are kept). ` +
    'With screenshots "all" (default) the record also has the page before and after each step (steps[].shots: ' +
    'JPEG paths inside run_dir, PNG for an Android device\'s screen; fields that received a secret are masked); "failed" keeps only the page the ' +
    'failing step left, "off" none. ' +
    'Nawi launches a fresh browser with a throwaway profile (headed unless headless is true), or opens a new tab ' +
    'in a browser already listening for DevTools on this machine (cdp_endpoint). ${env.*} and ${secret.*} values ' +
    'come only from this call\'s env and secrets; secret values are scrubbed from everything reported. ' +
    'Android flows run on the connected device or running emulator (target: its serial or AVD name when several are connected; none is ' +
    'booted, and the app must be installed: mobile_open does both). Nawi force-stops the app and starts it from its launcher so the run ' +
    'begins on its first screen, unless launch is false (then the steps act on the app as it is). The reply and record name the device ' +
    '(device). An Android run\'s record also keeps each step\'s device log: the app\'s warnings and errors, and system lines naming its package ' +
    '(steps[].logcat, first 3 in the reply). A crash or ANR of the app fails the step it happens in, with steps[].crash ' +
    '(kind crash|native_crash|anr, process, pid, summary) and its report first in steps[].logcat, record or not; ' +
    'headless and cdp_endpoint apply to browser flows only. A step ' +
    'failure is a normal result with status "failed"; errors are for files, browsers or devices that cannot be used (detail.fix says what to do). ' +
    'Send a progressToken in _meta (and accept text/event-stream) to get a notifications/progress message as ' +
    'each step settles. Pausing agent access, cancelling the call (notifications/cancelled), or disconnecting ' +
    'stops a run after the step in progress.',
  idempotent: false,
  errors: ['NOT_FOUND', 'NOT_IMPLEMENTED', 'UNAVAILABLE'],
  schema: z.object({
    file: z.string().min(1).max(MAX_FLOW_PATH).describe('Absolute path to the flow file.'),
    vars: inputMap('vars').describe('Values for vars the flow declares, overriding the file\'s defaults.'),
    env: inputMap('env values').describe('Values for ${env.NAME} references.'),
    secrets: inputMap('secrets').describe('Values for ${secret.name} references. Never stored or reported.'),
    headless: z.boolean().default(false),
    cdp_endpoint: z.string().max(200).optional().describe('e.g. "9222" or "127.0.0.1:9222". Loopback only.'),
    step_timeout_ms: z.number().int().min(100).max(600_000).optional().describe('Default per-step timeout (5000).'),
    screenshots: z
      .enum(['all', 'failed', 'off'])
      .default('all')
      .describe('Page screenshots around each step in the run record.'),
    target: z
      .string()
      .regex(TARGET_RE, 'an adb serial (see mobile_doctor devices) or an AVD name')
      .optional()
      .describe('Android flows: device serial or AVD name of a running emulator; default: the only connected device.'),
    launch: z.boolean().optional().describe('Android flows: start the app fresh from its launcher first (default true).')
  }),
  async run(args, ctx) {
    const { redactionRules } = await settings.getSettings()
    return withAgentStop(ctx, (signal) =>
      runFlowFile(
        {
          file: args.file,
          vars: args.vars,
          env: args.env,
          secrets: args.secrets,
          headless: args.headless,
          cdpEndpoint: args.cdp_endpoint,
          stepTimeoutMs: args.step_timeout_ms,
          screenshots: args.screenshots,
          device: args.target,
          launch: args.launch
        },
        {
          signal,
          record: { dir: runsDir(), appVersion: app.getVersion(), redactionRules },
          onStep: ctx.progress ? (step) => ctx.progress?.(stepProgress(step)) : undefined
        }
      )
    )
  }
})

/**
 * Runs `work` with a signal that fires when agent access is paused in Nawi or the caller cancels, so a replay stops
 * after the step in progress. Refuses before starting when access is already paused.
 */
async function withAgentStop<T>(ctx: { signal?: AbortSignal }, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController()
  const pause = (): void => stop.abort('agent access was paused in Nawi, so the remaining steps were not run')
  const off = settings.onSettingsChanged((next) => {
    if (next.agentAccessPaused) pause()
  })
  try {
    // Paused between dispatch's check and the subscription above: refuse before launching anything.
    if ((await settings.getSettings()).agentAccessPaused) throw agentAccessPaused()
    return await work(ctx.signal ? AbortSignal.any([stop.signal, ctx.signal]) : stop.signal)
  } finally {
    off()
  }
}

/** Roadmap F4c: the saved run records, newest first, without their steps. */
const listRunsTool = defineTool({
  name: 'list_runs',
  description:
    'List saved flow run records (from run_flow / nawi run), newest first: run_id, flow, status, start time, ' +
    'duration, step totals and the failing step; apply_heal\'s replays carry heal_of (the run whose proposals they ' +
    'replayed). Filter by status or flow file; limit defaults to 20. ' +
    'Use get_run for one run\'s steps and evidence.',
  idempotent: true,
  errors: [],
  schema: z.object({
    limit: z.number().int().min(1).max(DEFAULT_KEEP_RUNS).default(20),
    status: z.enum(['passed', 'failed']).optional(),
    flow_file: z.string().min(1).max(MAX_FLOW_PATH).optional().describe('Resolved absolute path (symlinks followed) of the flow file, as the run recorded it (`flow.file` in list_runs).')
  }),
  async run(args) {
    const runs = await listRuns(runsDir(), { limit: args.limit, status: args.status, flowFile: args.flow_file })
    return { runs, count: runs.length }
  }
})

/** Roadmap F4c: one run record in full. */
const getRun = defineTool({
  name: 'get_run',
  description:
    'Fetch one saved run record by run_id: per step the status, timing, the locator that matched and the ones that ' +
    'missed, the error, the page URL, console errors and failed requests, and the screenshot paths (relative to ' +
    'run_dir: before/after JPEGs in steps[].shots, PNGs of screenshot steps). run_dir also holds junit.xml and ' +
    'report.html (runs saved by this version of Nawi or later): a self-contained page with the screenshots embedded that a person can open in a browser.',
  idempotent: true,
  errors: ['NOT_FOUND'],
  schema: z.object({
    run_id: z.string().regex(RUN_ID_RE, 'a run id such as 20261102T103900123Z-a1b2c3 (see list_runs)')
  }),
  async run(args) {
    const record = await readRunRecord(runsDir(), args.run_id)
    if (!record) throw new ToolError('NOT_FOUND', `No saved run ${args.run_id}. Call list_runs for the runs that exist.`, { run_id: args.run_id })
    return { ...record, run_dir: join(runsDir(), args.run_id) }
  }
})

/**
 * Roadmap F6 (F6a, F6c): healing proposals from a saved run, as a reviewable YAML patch. Reads only; the flow
 * file is never written here.
 */
const getHealProposals = defineTool({
  name: 'get_heal_proposals',
  description:
    'Propose fixes for a flow that is drifting from the app, from one saved run (run_id from list_runs): for each ' +
    'step that passed only through a fallback locator, a YAML patch that moves the locator that matched to the front ' +
    'and drops the ones that found nothing, with the evidence (matched and missed locators, URL, before/after ' +
    'screenshots relative to the run folder). A step found only by its reference crop (layer "visual") gets that ' +
    "element's own locators added in front instead (added; unverified until replayed). A failed step nothing found " +
    'gets a suggestion when one control on the page has a name close to its intent or its locators\' names (layer ' +
    '"suggested", unverified: true): that control\'s locators in front, the flow\'s own kept after them. Also lists steps it cannot ' +
    'heal from the record and why. Nothing is ' +
    'written: review the diff, then apply it yourself or with apply_heal (which replays it first). flow_status ' +
    '"changed" means the flow file was edited since the run: run it again first.',
  idempotent: true,
  errors: ['NOT_FOUND'],
  schema: z.object({
    run_id: z.string().regex(RUN_ID_RE, 'a run id such as 20261102T103900123Z-a1b2c3 (see list_runs)')
  }),
  async run(args) {
    const record = await readRunRecord(runsDir(), args.run_id)
    if (!record) throw new ToolError('NOT_FOUND', `No saved run ${args.run_id}. Call list_runs for the runs that exist.`, { run_id: args.run_id })
    return { ...healProposals(record, await readRunFlow(record)), run_dir: join(runsDir(), args.run_id) }
  }
})

/**
 * Roadmap F6 (second slice): write a healing proposal into the flow file, only after a replay of the proposed flow
 * holds (see heal/apply.ts). `confirm: true` is the explicit consent to write the user's file.
 */
const applyHealTool = defineTool({
  name: 'apply_heal',
  description:
    'Apply the healing proposals of one saved run (see get_heal_proposals) to its flow file: only the steps in ' +
    'step_ids (default: every proposal). Nawi first replays the proposed flow in a browser, or for an android flow on the device the run used and with its launch setting (it is saved as a run ' +
    'record like run_flow\'s, with heal_of = run_id) and writes the file only when that replay passed, each healed step matched through ' +
    'its new first locator, and no other step needed a fallback it did not need before; a wrong match (the moved ' +
    'locator finds another element, so a later step fails) is rejected and nothing is written. The write changes ' +
    'only what the diff shows, atomically, and only while the file is still the one the run replayed (read-only or ' +
    'non-UTF-8 files are left alone). confirm must be true: it writes the user\'s flow file, so show them the diff first. applied: false ' +
    'comes with the reason. vars, env, secrets, headless, cdp_endpoint and step_timeout_ms are as in run_flow.',
  idempotent: false,
  errors: ['NOT_FOUND', 'NOT_IMPLEMENTED', 'UNAVAILABLE'],
  schema: z.object({
    run_id: z.string().regex(RUN_ID_RE, 'a run id such as 20261102T103900123Z-a1b2c3 (see list_runs)'),
    step_ids: z.array(z.string().min(1).max(200)).min(1).max(500).optional().describe('Steps to heal; default every proposal.'),
    confirm: z.literal(true).describe('Must be true: this writes the flow file.'),
    vars: inputMap('vars').describe('Values for vars the flow declares, overriding the file\'s defaults.'),
    env: inputMap('env values').describe('Values for ${env.NAME} references.'),
    secrets: inputMap('secrets').describe('Values for ${secret.name} references. Never stored or reported.'),
    headless: z.boolean().default(false),
    cdp_endpoint: z.string().max(200).optional().describe('e.g. "9222" or "127.0.0.1:9222". Loopback only.'),
    step_timeout_ms: z.number().int().min(100).max(600_000).optional().describe('Default per-step timeout (5000).')
  }),
  async run(args, ctx) {
    const record = await readRunRecord(runsDir(), args.run_id)
    if (!record) throw new ToolError('NOT_FOUND', `No saved run ${args.run_id}. Call list_runs for the runs that exist.`, { run_id: args.run_id })
    const { redactionRules } = await settings.getSettings()
    return withAgentStop(ctx, (signal) =>
      applyHeal(record, args.step_ids, {
        readFlow: () => readRunFlow(record),
        realPath: () => resolveFlowFile(record.flow.file),
        replay: (source) =>
          runFlowFile(
            {
              file: record.flow.file,
              vars: args.vars,
              env: args.env,
              secrets: args.secrets,
              headless: args.headless,
              cdpEndpoint: args.cdp_endpoint,
              stepTimeoutMs: args.step_timeout_ms,
              screenshots: 'all',
              // An android run is replayed on the same device (AVD name or serial), restarted only if the run restarted it.
              // run.json is not schema-checked past its summary fields: a device name is re-validated by prepareAndroidRun.
              ...androidReplayOf(record)
            },
            {
              signal,
              source,
              healOf: record.run_id,
              record: { dir: runsDir(), appVersion: app.getVersion(), redactionRules },
              onStep: ctx.progress ? (step) => ctx.progress?.(stepProgress(step)) : undefined
            }
          ),
        signal
      })
    )
  }
})

/**
 * Roadmap M1 (first slice): what an Android app declares, read offline from its .apk, before Nawi installs and
 * drives it. Each refusal carries a `fix` in its detail.
 */
const inspectApk = defineTool({
  name: 'inspect_apk',
  description:
    'Read an Android app package (*.apk, absolute path inside your home directory) without installing it or ' +
    'needing the Android SDK: package name, version code/name, min and target SDK, the launcher activity ' +
    '(`am start -n <package>/<launcher_activity>`), native ABIs (empty: runs on any device), whether it is ' +
    'debuggable, requested permissions (runtime: true for the ones a dialog would ask for), deep links ' +
    '(scheme://host/path per activity, auto_verify for verified App Links), exported components, and `framework`: ' +
    'the UI framework (native, flutter, react_native, game_engine, webview, from marker files in the package) with ' +
    'the `read_strategy` for its screen (accessibility, flutter_semantics, webview_cdp for a debuggable WebView app, ' +
    'or screenshot when there is no element tree), ' +
    'the deciding files as `evidence` and a `note` on what makes its locators reliable. ' +
    'An .aab is refused with the bundletool command that converts it. Every error has detail.fix: the one thing ' +
    'to do about it.',
  idempotent: true,
  errors: ['NOT_FOUND', 'NOT_IMPLEMENTED'],
  schema: z.object({
    file: z.string().min(1).max(MAX_FLOW_PATH).describe('Absolute path to the .apk file.')
  }),
  async run(args) {
    return readApk(args.file)
  }
})

/** inspectApkFile with each ApkError kind mapped onto a typed code and the fix in detail (inspect_apk, mobile_doctor). */
async function readApk(file: string) {
  try {
    return await inspectApkFile(file)
  } catch (err) {
    if (!(err instanceof ApkError)) throw err
    const detail = { file, fix: err.fix }
    if (err.kind === 'not_found') throw new ToolError('NOT_FOUND', err.message, detail)
    if (err.kind === 'unsupported') throw new ToolError('NOT_IMPLEMENTED', err.message, detail)
    throw new ToolError('INVALID_ARGUMENTS', err.message, detail)
  }
}

const mobileDoctor = defineTool({
  name: 'mobile_doctor',
  description:
    'Check whether this machine can run an Android app, and if not, the one thing to do next. Finds the Android ' +
    'SDK (ANDROID_HOME, ANDROID_SDK_ROOT, the default install folder, adb on PATH), adb, the emulator, hardware ' +
    'virtualization (KVM on Linux, `emulator -accel-check` elsewhere), connected devices (API level and ABIs over ' +
    'adb) and virtual devices (AVDs, read from their config without booting them). With `file` (an .apk inside your ' +
    'home directory, as for inspect_apk) each device is matched against the app\'s min SDK and native ABIs. ' +
    'It reads the environment Nawi itself started with (ANDROID_HOME etc. of the app or `nawi serve`). ' +
    'Returns ready, recommended ({kind: device|avd, name}), fix (one sentence, null when ready) and per-check ' +
    'status ok/warn/fail/skipped with its own fix. Changes nothing (it may start the adb server); mobile_open installs ' +
    'and launches the app.',
  idempotent: false,
  errors: ['NOT_FOUND', 'NOT_IMPLEMENTED'],
  schema: z.object({
    file: z.string().min(1).max(MAX_FLOW_PATH).optional().describe('Absolute path to an .apk to match devices against.')
  }),
  async run(args) {
    const apk = args.file === undefined ? null : await readApk(args.file)
    return runMobileDoctor(apk)
  }
})

/** readProfileFile with its refusals mapped like readApk's (mobile_open). */
async function readProfile(file: string): Promise<MobileProfile> {
  try {
    return await readProfileFile(file)
  } catch (err) {
    if (!(err instanceof ProfileFileError)) throw err
    throw new ToolError(err.kind === 'not_found' ? 'NOT_FOUND' : 'INVALID_ARGUMENTS', err.message, { file, fix: err.fix })
  }
}

/** mobile_open's arguments, also used by the window's drop-an-.apk view (roadmap M1d). */
export interface MobileOpenArgs {
  file: string
  target?: string
  grant: boolean
  headless: boolean
  boot_timeout_ms?: number
  save_profile: boolean
  profile?: string
  /** Also tap the first-run blockers Nawi names a tap for, and save those taps in the profile's onboarding. */
  learn_onboarding?: boolean
  /** Values for the profile's sign_in `${env.NAME}` / `${secret.name}` references. Never stored or reported. */
  env?: Record<string, string>
  secrets?: Record<string, string>
}

/**
 * The body of mobile_open without the agent-access gate: read the .apk (or profile), install and launch it, save the
 * profile. The MCP tool wraps it with the kill switch; the window calls it directly, since a drop is the user's own
 * action. Throws ToolError for a bad file (with `detail.fix`), and the abort reason when `signal` fires.
 */
export async function openMobileFile(
  args: MobileOpenArgs,
  opts: { signal: AbortSignal; onStep?: (id: OpenStepId, summary: string) => void }
) {
  const fromProfile = isProfilePath(args.file) ? await readProfile(args.file) : null
  const apkFile = fromProfile ? fromProfile.app.apk : args.file
  const apk = await readApk(apkFile)
  if (fromProfile && apk.package !== fromProfile.app.package) {
    throw new ToolError('INVALID_ARGUMENTS', `The profile is for ${fromProfile.app.package}, but ${apkFile} is now ${apk.package}.`, {
      file: args.file,
      fix: 'Open the .apk itself to write a new profile for it.'
    })
  }
  // The real path goes to adb (readApk already confined it to the home folder).
  const real = await realpath(apkFile)
  // Hashed alongside the install, and only when a profile is written or compared.
  const hashing = args.save_profile || fromProfile ? sha256File(real).then((h) => h, () => null) : Promise.resolve(null)
  const grant = !args.grant ? [] : (fromProfile?.permissions.grant ?? null)

  const result = await openApp({
    apkFile: real,
    apk,
    target: args.target ?? fromProfile?.target?.name ?? null,
    grant,
    activity: fromProfile?.launch.activity ?? null,
    // A profile from before M2b has no device section: it keeps leaving the device alone. A new open gets the
    // defaults for the device it lands on.
    settings: fromProfile ? (fromProfile.device ?? null) : undefined,
    // Values in a profile pinned to a phone were written for a phone; any other profile's stay off physical devices.
    settingsOnPhone: fromProfile?.target?.kind === 'device',
    onboarding: fromProfile?.onboarding ?? null,
    learnOnboarding: args.learn_onboarding ?? false,
    signIn: fromProfile?.sign_in ?? null,
    inputs: { env: args.env, secrets: args.secrets },
    headless: args.headless,
    bootTimeoutMs: args.boot_timeout_ms,
    signal: opts.signal,
    onStep: opts.onStep
  })
  const sha256 = await hashing
  const apkChanged = fromProfile && sha256 ? fromProfile.app.sha256 !== sha256 : null
  let profile: string | null = null
  let profileError: string | null = null
  if (result.ok && args.save_profile && result.target && sha256) {
    const app = { apk: apkFile, package: apk.package, version_code: apk.version_code, version_name: apk.version_name, sha256 }
    const screen = { framework: apk.framework.kind, read: apk.framework.read_strategy }
    // Taps learned in this open (learn_onboarding) join the saved ones; the saved ones stay as the user left them.
    const learned = (result.onboarding?.tapped ?? []).filter((t) => t.learned).map((t) => ({ when: t.when, tap: t.tap }))
    const savedTaps = fromProfile?.onboarding ?? []
    const { taps: onboarding, dropped } = mergeOnboarding(savedTaps, learned)
    if (dropped > 0) profileError = `${dropped} learned onboarding tap${dropped === 1 ? ' was' : 's were'} not saved: the profile already holds ${MAX_ONBOARDING_ENTRIES}; remove the ones it no longer needs.`
    const taps = onboarding.length > 0 ? { onboarding } : {}
    // From a profile, only the app facts (and newly learned taps) are refreshed: the target, permissions, activity
    // and device settings it pins (or leaves null for "best available" / "launcher" / "as it is") are the user's
    // choice, and a one-off --target doesn't change them.
    const next: MobileProfile | null = fromProfile
      ? apkChanged || args.profile !== undefined || onboarding.length !== savedTaps.length
        ? { ...fromProfile, app, screen, ...taps }
        : null
      : {
          version: 1,
          app,
          target: { kind: result.target.kind, name: result.target.name },
          permissions: { grant: runtimePermissionsFor(apk, result.target.api) },
          launch: { activity: result.launched?.activity ?? null },
          screen,
          // What openApp chose for this device (its defaults, minus what its Android version lacks).
          ...(result.settings.requested ? { device: result.settings.requested } : {}),
          ...taps
        }
    const out = args.profile ?? (fromProfile ? args.file : defaultProfilePath(apkFile, apk.package))
    if (next === null) profile = args.file
    else {
      try {
        profile = await writeProfileFile(out, next)
      } catch (err) {
        profileError = err instanceof ProfileFileError ? `${err.message} ${err.fix}` : `the profile could not be saved: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
  return { ...result, apk: apkFile, sha256, apk_changed: apkChanged, profile, profile_error: profileError }
}

/**
 * Roadmap M1 (third slice): install an app on a device and start it, then save a mobile profile that repeats it.
 */
const mobileOpen = defineTool({
  name: 'mobile_open',
  description:
    'Install an Android app on a device and start it, ready to be driven. `file` is an .apk, or a mobile profile ' +
    '(*.nawi.mobile.yaml) saved by an earlier call (absolute paths inside your home directory). Nawi picks the ' +
    'device like mobile_doctor does (a connected device first, else the newest virtual device (AVD) that can run ' +
    'the app) unless `target` names one (adb serial or AVD name); boots that AVD when it is not running (it keeps ' +
    'running afterwards; headless: true starts it without a window), installs the app (replacing an installed copy ' +
    'and keeping its data), grants its runtime permissions with `pm grant` so no permission dialog blocks a run ' +
    '(grant: false skips that), applies device settings, and starts its launcher activity. Device settings on a ' +
    'virtual device default to English (en-US, the app\'s own locale), light theme, font scale 1, animations ' +
    'off and network on (airplane mode off; network: false in the profile runs the app offline) (minus what its Android version lacks), so runs see the same screen; a physical phone is left as it is ' +
    'unless the profile was saved for that phone and its device section asks for a value (global settings such as ' +
    'animations and airplane mode stay changed afterwards). ' +
    'Returns ok, fix (the one next step when not ok), target ({kind, name, serial, api, booted}), permissions ' +
    '({granted, not_granted}), settings ({requested, applied, not_applied}: keys of the profile\'s device section), launched ({activity, total_time_ms, ' +
    'pid}), first_screen ({package, blockers}: the screen read once with uiautomator after launch; each blocker has ' +
    'kind permission_dialog/consent/intro/login_wall, summary, tap (a {resource_id|content_desc|text} locator for the ' +
    'element that gets past it, null for a sign-in form) and fix), onboarding ({tapped: [{when, tap, label, ' +
    'learned}]} or null), sign_in ({fields, submitted, signed_in} or null) and per-step status ' +
    '(doctor/boot/install/grant/settings/launch/onboarding/sign_in/first_screen: ok/warn/fail/skipped with its own fix). ' +
    'Onboarding: a profile\'s onboarding taps are replayed after launch (while a saved element is on screen it is ' +
    'tapped and the screen read again, at most 10 taps; a permission_dialog tap lands only on Android\'s prompt, ' +
    'others only on the app); first_screen then shows what is left. learn_onboarding: true also taps the blockers ' +
    'Nawi names a tap for (this accepts consent screens on that device) and saves them in the profile\'s ' +
    'onboarding, so one open learns the sequence; without it Nawi taps only saved taps. A sign-in form is never ' +
    'tapped past: with a profile whose sign_in section names the form\'s fields and submit button, a sign-in form ' +
    'still in front of the app is filled in (each field tapped, cleared and typed into with the value of its ' +
    '${secret.name} / ${env.NAME} reference from this call\'s secrets / env, then submit tapped, then up to 20 s for ' +
    'the form to go); sign_in reports {fields, submitted, signed_in}, never the values, and secret values are ' +
    'scrubbed from everything returned. ' +
    'A device or setup problem is a ' +
    'normal result with ok: false, not an error. ' +
    'On success it saves the profile (app path + SHA-256, target, permissions, activity, screen: the UI framework ' +
    'and how its screen is read, device: the settings) next to the .apk as ' +
    '<package>.nawi.mobile.yaml, or to `profile`; save_profile: false skips it. With a profile, its target, ' +
    'permission list, activity and device settings are used and kept (null target: the best device; null activity: ' +
    'the launcher; a null setting or no device section: leave the device as it is); only its app facts (SHA-256, ' +
    'version, screen) are updated when the .apk changed. Booting can take minutes: send a ' +
    'progressToken in _meta to get a notifications/progress message per step. Pausing agent access or cancelling ' +
    'the call stops it before the next step. The device screen is shown in Nawi\'s window (drop the .apk there), not returned here.',
  idempotent: false,
  errors: ['NOT_FOUND', 'NOT_IMPLEMENTED'],
  schema: z.object({
    file: z.string().min(1).max(MAX_FLOW_PATH).describe('Absolute path to the .apk, or to a *.nawi.mobile.yaml profile.'),
    target: z.string().regex(TARGET_RE, 'an adb serial (see mobile_doctor devices) or an AVD name').optional().describe('Device serial or AVD name; default: the best available.'),
    grant: z.boolean().default(true).describe('Grant the runtime permissions before launch.'),
    headless: z.boolean().default(false).describe('Boot a virtual device without a window.'),
    boot_timeout_ms: z.number().int().min(10_000).max(900_000).optional().describe('How long to wait for a virtual device to boot (180000).'),
    save_profile: z.boolean().default(true),
    learn_onboarding: z.boolean().default(false).describe('Tap past the first-run screens Nawi recognises and save those taps in the profile.'),
    env: inputMap('env values').describe('Values for the profile sign_in ${env.NAME} references.'),
    secrets: inputMap('secrets').describe('Values for the profile sign_in ${secret.name} references. Never stored or reported.'),
    profile: z.string().min(1).max(MAX_FLOW_PATH).optional().describe('Where to save the profile (absolute, *.nawi.mobile.yaml).')
  }),
  async run(args, ctx) {
    const stop = new AbortController()
    const off = settings.onSettingsChanged((next) => {
      if (next.agentAccessPaused) stop.abort(agentAccessPaused())
    })
    let step = 0
    try {
      if ((await settings.getSettings()).agentAccessPaused) throw agentAccessPaused()
      return await openMobileFile(args, {
        signal: ctx.signal ? AbortSignal.any([stop.signal, ctx.signal]) : stop.signal,
        // Boot and grant are skipped on some opens, so there is no fixed total.
        onStep: ctx.progress ? (id, summary) => ctx.progress?.({ progress: ++step, message: `${id}: ${summary}` }) : undefined
      })
    } finally {
      off()
    }
  }
})

/** Where saved screen studies live: one folder per study (study.json + screen.png). */
export const studiesDir = (): string => join(app.getPath('userData'), 'studies')

/**
 * How many elements and findings a mobile_study answer carries (a dump may hold 10,000 nodes); study.json in the
 * study folder always has them all.
 */
export const MAX_STUDY_ELEMENTS = 150
export const MAX_STUDY_FINDINGS = 100

/**
 * Roadmap M3 (second slice, M3b): study the screen a connected device shows now, with a screenshot.
 */
const mobileStudy = defineTool({
  name: 'mobile_study',
  description:
    'Study the screen a connected Android device shows right now: what a test or a person can act on, how to find ' +
    'each element again, and what to fix for testability and accessibility. Reads the screen with uiautomator and ' +
    '`wm density` and takes a screenshot; installs, launches, taps and boots nothing (start the app with mobile_open ' +
    'first). `target` is an adb serial or the AVD name of a running emulator; without it the only connected device ' +
    'is used (several connected: ok false, fix says to pick one). `package` is the app whose views are judged ' +
    '(default: the first app window on screen; Android\'s own permission prompt and notification shade are never judged). ' +
    'Returns ok, error and fix (the one next step when not ok), target ({kind, name, serial, api}), study_id, ' +
    'screen_id (s-<12 hex>: the same screen gets the same id across runs while its content changes), package, ' +
    'rotation, density_dpi, elements (each with i, class, resource_id, content_desc, text (empty for password fields), ' +
    'hint, label (what a screen reader says), bounds, clickable/long_clickable/checkable/focusable/scrollable/enabled, ' +
    'locator: the shortest {resource_id|content_desc|text} that finds only it, null when none does, ' +
    'locator_basis resource_id/content_desc/text/index, in_collection), findings ({kind missing_label / ' +
    'small_touch_target (under 48 dp) / duplicate_resource_id / missing_resource_id / fragile_locator / low_contrast ' +
    '(text under 4.5:1 against its background on the screenshot: error under 3:1, warning from 3:1), severity, ' +
    'element, summary, fix}), notes (what could not be checked), and screenshot: the PNG\'s path, or null with ' +
    `screenshot_error saying why. At most ${MAX_STUDY_ELEMENTS} elements and ${MAX_STUDY_FINDINGS} findings are returned ` +
    '(elements_total / findings_total say how many there are; study.json in study_dir has them all; save_error when it ' +
    'could not be saved). The study is saved under Nawi\'s studies folder (study.json + screen.png; the ' +
    `newest ${DEFAULT_KEEP_STUDIES} are kept). \`secrets\`: values typed into the app (a sign-in); they are replaced by ` +
    '${secret.name} in everything returned and saved, and when one is on the screen no screenshot is taken. ' +
    'A device problem is a normal result with ok: false, not an error.',
  idempotent: false,
  errors: [],
  schema: z.object({
    target: z.string().regex(TARGET_RE, 'an adb serial (see mobile_doctor devices) or an AVD name').optional().describe('Device serial or AVD name of a running emulator; default: the only connected device.'),
    package: z.string().regex(PACKAGE_RE, 'an Android package name').optional().describe('The app whose views are judged; default: the app in front.'),
    secrets: inputMap('secrets').describe('Values typed into the app, scrubbed from the result. Never stored or reported.')
  }),
  async run(args) {
    const takenAt = Date.now()
    const live = await studyLiveScreen({ target: args.target ?? null, package: args.package ?? null, secrets: args.secrets })
    if (!live.ok || !live.study) {
      return { ok: false, error: live.error, fix: live.fix, target: live.target, study_id: null, study_dir: null, screenshot: null, screenshot_error: null }
    }
    const id = newRunId(takenAt)
    let saved: { dir: string; screenshot: string | null } | null = null
    let saveError: string | null = null
    try {
      saved = await writeStudy(studiesDir(), id, { study: live.study, target: live.target, taken_at: new Date(takenAt).toISOString() }, live.screenshot?.png ?? null)
      await pruneRuns(studiesDir(), DEFAULT_KEEP_STUDIES).catch(() => [])
    } catch (err) {
      // The study itself is the answer; only the saved copy (and the screenshot, which lives in it) is lost.
      saveError = `the study could not be saved: ${err instanceof Error ? err.message : String(err)}`
    }
    const { elements, findings, ...facts } = live.study
    return {
      ok: true,
      error: null,
      fix: null,
      target: live.target,
      study_id: saved ? id : null,
      study_dir: saved?.dir ?? null,
      save_error: saveError,
      ...facts,
      elements: elements.slice(0, MAX_STUDY_ELEMENTS),
      elements_total: elements.length,
      findings: findings.slice(0, MAX_STUDY_FINDINGS),
      findings_total: findings.length,
      screenshot: saved?.screenshot ?? null,
      screenshot_size: saved?.screenshot && live.screenshot ? { width: live.screenshot.width, height: live.screenshot.height } : null,
      // Why there is no screenshot: withheld or failed on the device, else lost with the study folder (save_error).
      screenshot_error: saved?.screenshot ? null : (live.screenshot_error ?? (live.screenshot ? 'not saved: see save_error' : null))
    }
  }
})

/** Where saved explorations live: one folder per run (graph.json + <screen_id>.png per screen). */
export const explorationsDir = (): string => join(app.getPath('userData'), 'explorations')

/** How much of a screen graph a mobile_explore answer carries; graph.json in the exploration folder has it all. */
export const MAX_EXPLORE_SCREENS = 50
export const MAX_EXPLORE_FINDINGS_PER_SCREEN = 10
export const MAX_EXPLORE_EDGES = 200
export const MAX_EXPLORE_SKIPPED = 100

/**
 * Roadmap M3 (fourth slice, M3c2): explore the app a connected device shows now and save its screen graph.
 */
const mobileExplore = defineTool({
  name: 'mobile_explore',
  description:
    'Explore the Android app a connected device shows right now and map it: from the screen in front, tap each ' +
    'control that is safe to tap, study the screen it opens (like mobile_study), press Back, and repeat depth first ' +
    'until every safe control within max_depth was tapped or a budget runs out. Safe means nothing is destroyed, ' +
    'bought, sent or typed: controls whose label, description or view id say delete, remove, pay, buy, send, save, ' +
    'sign out, ... (plus the `never_press` words you add) are never pressed; text fields, switches, checkboxes and ' +
    'controls covered by another are never touched; the keyboard is hidden before every tap. Installs, launches and ' +
    'boots nothing: start the app with mobile_open first. `target` and `package` work like mobile_study (default: ' +
    'the only connected device, the app in front). Returns ok, error and fix (the one next step when not ok), target, ' +
    'package, density_dpi, exploration_id, exploration_dir, start (the first screen_id), stopped (done / max_screens / ' +
    'max_taps / max_time / lost / unreadable / device_error / cancelled / not_in_app), taps, notes (why it stopped, ' +
    'what it could not do), screens ({screen_id, depth, path: the labels tapped from the start screen, ' +
    'elements_total, findings_total, findings ({kind, severity, summary, fix}), screenshot: the PNG\'s path or null ' +
    'with screenshot_error}), edges ({from, to, label, result: screen / same_screen / left_app, package for left_app}), ' +
    'skipped ({screen_id, label, reason: never_press / text_field / toggle / covered / no_locator / repeated_row / ' +
    `gone}) and findings_total. At most ${MAX_EXPLORE_SCREENS} screens (${MAX_EXPLORE_FINDINGS_PER_SCREEN} findings each), ` +
    `${MAX_EXPLORE_EDGES} edges and ${MAX_EXPLORE_SKIPPED} skipped controls are returned (*_total say how many there are); ` +
    'graph.json in exploration_dir has them all, with each screen\'s full study (save_error when it could not be ' +
    `saved). The newest ${DEFAULT_KEEP_EXPLORATIONS} explorations are kept. \`secrets\`: values typed into the app (a ` +
    'sign-in); they are replaced by ${secret.name} in everything returned and saved, and a screen showing one keeps ' +
    'no screenshot. Send a progressToken in _meta to get a notifications/progress message per screen found. Pausing ' +
    'agent access or cancelling stops the run before its next tap (stopped: cancelled; what was found is kept). A ' +
    'device problem is a normal result with ok: false, not an error.',
  idempotent: false,
  errors: [],
  schema: z.object({
    target: z.string().regex(TARGET_RE, 'an adb serial (see mobile_doctor devices) or an AVD name').optional().describe('Device serial or AVD name of a running emulator; default: the only connected device.'),
    package: z.string().regex(PACKAGE_RE, 'an Android package name').optional().describe('The app to explore; it must be in front. Default: the app in front.'),
    max_depth: z.number().int().min(1).max(10).default(DEFAULT_MAX_DEPTH).describe('Taps from the start screen to the deepest screen explored.'),
    max_screens: z.number().int().min(1).max(200).default(DEFAULT_MAX_SCREENS).describe('Distinct screens to find before stopping.'),
    max_taps: z.number().int().min(1).max(1000).default(DEFAULT_MAX_TAPS).describe('Taps on the app\'s controls before stopping (Back not counted).'),
    time_budget_s: z.number().int().min(10).max(3600).default(DEFAULT_TIME_BUDGET_MS / 1000).describe('Seconds before stopping.'),
    never_press: z
      .array(z.string().regex(NEVER_PRESS_WORD_RE, 'a word or short phrase (letters and digits, up to 40 characters)'))
      .max(MAX_NEVER_PRESS_WORDS)
      .optional()
      .describe('Words added to the never-press list for this app (e.g. "archive", "mark read"), matched as whole words.'),
    secrets: inputMap('secrets').describe('Values typed into the app, scrubbed from the result. Never stored or reported.')
  }),
  async run(args, ctx) {
    const stop = new AbortController()
    const off = settings.onSettingsChanged((next) => {
      if (next.agentAccessPaused) stop.abort(agentAccessPaused())
    })
    // The exploration whose screenshots are spooled to its temp folder but not saved yet (dropped in finally).
    let spooled: string | null = null
    try {
      if ((await settings.getSettings()).agentAccessPaused) throw agentAccessPaused()
      const takenAt = Date.now()
      const id = newRunId(takenAt)
      spooled = id
      const live = await exploreLiveApp({
        target: args.target ?? null,
        package: args.package ?? null,
        maxDepth: args.max_depth,
        maxScreens: args.max_screens,
        maxTaps: args.max_taps,
        timeBudgetMs: args.time_budget_s * 1000,
        neverPress: args.never_press,
        secrets: args.secrets,
        signal: ctx.signal ? AbortSignal.any([stop.signal, ctx.signal]) : stop.signal,
        // Each screenshot goes to disk as it is taken, not into memory until the run ends.
        storeScreenshot: screenshotSpool(explorationsDir(), id),
        onScreen: ctx.progress
          ? (s, found) => ctx.progress?.({ progress: found, total: args.max_screens, message: `${s.screen_id}: depth ${s.depth}, ${s.study.findings.length} findings` })
          : undefined
      })
      const x = live.exploration
      if (!live.ok || !x || live.package === null) {
        return { ok: false, error: live.error, fix: live.fix, target: live.target, package: live.package, exploration_id: null, exploration_dir: null, stopped: x?.stopped ?? null, notes: x?.notes ?? [] }
      }
      let saved: { dir: string; screenshots: Map<string, string> } | null = null
      let saveError: string | null = null
      try {
        saved = await writeExploration(explorationsDir(), id, { target: live.target, package: live.package, density_dpi: live.density_dpi, taken_at: new Date(takenAt).toISOString(), exploration: x })
        spooled = null // the temp folder is now the saved exploration
        await pruneRuns(explorationsDir(), DEFAULT_KEEP_EXPLORATIONS).catch(() => [])
      } catch (err) {
        // The graph itself is the answer; only the saved copy (and the screenshots, which live in it) is lost.
        saveError = `the exploration could not be saved: ${err instanceof Error ? err.message : String(err)}`
      }
      return {
        ok: true,
        error: null,
        fix: null,
        target: live.target,
        package: live.package,
        density_dpi: live.density_dpi,
        exploration_id: saved ? id : null,
        exploration_dir: saved?.dir ?? null,
        save_error: saveError,
        start: x.start,
        stopped: x.stopped,
        taps: x.taps,
        notes: x.notes,
        screens: x.screens.slice(0, MAX_EXPLORE_SCREENS).map((s) => {
          const screenshot = saved?.screenshots.get(s.screen_id) ?? null
          return {
            screen_id: s.screen_id,
            depth: s.depth,
            path: s.path.map((t) => t.label),
            elements_total: s.study.elements.length,
            findings_total: s.study.findings.length,
            findings: s.study.findings.slice(0, MAX_EXPLORE_FINDINGS_PER_SCREEN).map((f) => ({ kind: f.kind, severity: f.severity, summary: f.summary, fix: f.fix })),
            screenshot,
            // Why there is no screenshot: withheld or failed on the device, else lost with the folder (save_error).
            screenshot_error: screenshot ? null : (s.screenshot_error ?? (s.screenshot || s.screenshot_file ? 'not saved: see save_error' : null))
          }
        }),
        screens_total: x.screens.length,
        edges: x.edges.slice(0, MAX_EXPLORE_EDGES).map((e) => ({ from: e.from, to: e.to, label: e.tap.label, result: e.result, ...(e.package !== undefined ? { package: e.package } : {}) })),
        edges_total: x.edges.length,
        skipped: x.skipped.slice(0, MAX_EXPLORE_SKIPPED).map((k) => ({ screen_id: k.screen_id, label: k.label, reason: k.reason })),
        skipped_total: x.skipped.length,
        findings_total: x.screens.reduce((n, s) => n + s.study.findings.length, 0)
      }
    } finally {
      off()
      if (spooled !== null) await discardExploration(explorationsDir(), spooled).catch(() => undefined)
    }
  }
})

/**
 * Roadmap M5c (second slice): record what a person does on a connected Android device into an android flow.
 */
const mobileRecord = defineTool({
  name: 'mobile_record',
  description:
    'Record what a person does on a connected Android device into an android flow (*.nawi.yaml, target.kind ' +
    'android) that run_flow replays. The app is started from its launcher first (force-stop, then start, as run_flow ' +
    'does before a replay; launch: false records from the screen it shows now), then the device\'s touches and keys ' +
    'are read live (`adb shell getevent`) while the person uses the app: taps become click steps on the view under ' +
    'the finger (resource id, content description and text locators, each kept only when it finds that view alone), ' +
    'typing becomes one fill step per field with the final text, Back/Enter (and a Home that did not leave the app) become press steps, a touch resting ' +
    'past the device\'s touch & hold delay becomes a click with hold_ms (a long press), and the screen turning becomes a ' +
    'rotate step (a recording that turns the screen starts with one to where it started), and leaving the app with Home or ' +
    'the app switcher and coming back to it becomes a background step with the time away (ms), and a tap on an answer of ' +
    'Android\'s permission prompt (or Back while it shows, a deny) becomes a permission step (answer: allow, while_using, once or deny). A password ' +
    'field\'s text is never read: its fill types ${secret.<name>} at run time. Swipes, taps on other ' +
    'apps (or on the permission prompt\'s other views, such as its location accuracy choice) and touches that came before the screen after the previous tap was read (a read takes ' +
    'about 2 seconds) are not steps: warnings say which and why. Recording stops after idle_seconds without a touch ' +
    '(once something was recorded), after max_seconds, when cancelled (or agent access is paused: what was recorded ' +
    'is kept), when the device stops sending touches, or when its screen can no longer be read. `target` and `package` work like mobile_explore (default: ' +
    'the only connected device, the app in front). Returns ok, error and fix (the one next step when not ok), target, ' +
    'package, launched ({activity} or null), stopped (idle / max_time / cancelled / disconnected / unreadable), inputs (touches ' +
    'and keys read, typing included), steps, warnings, flow_yaml, and with output (an absolute *.nawi.yaml path inside ' +
    'your home folder, checked before recording starts) file: where it was written (save_error when it could not be; ' +
    'an existing file is replaced only with overwrite: true). Send a progressToken in _meta to get a ' +
    'notifications/progress message each time the screen has been read (the next touch is safe). A device problem ' +
    'is a normal result with ok: false, not an error.',
  idempotent: false,
  errors: ['NOT_FOUND'],
  schema: z.object({
    target: z.string().regex(TARGET_RE, 'an adb serial (see mobile_doctor devices) or an AVD name').optional().describe('Device serial or AVD name of a running emulator; default: the only connected device.'),
    package: z.string().regex(PACKAGE_RE, 'an Android package name').optional().describe('The app to record. Default: the app in front.'),
    launch: z.boolean().default(true).describe('Start the app from its launcher before recording, as a replay does. false: record from the screen it shows now.'),
    name: z.string().min(1).max(200).optional().describe('Flow name. Defaults to "Recorded on <package>".'),
    max_seconds: z.number().int().min(10).max(1800).default(DEFAULT_MAX_MS / 1000).describe('Longest the recording runs.'),
    idle_seconds: z.number().int().min(3).max(600).default(DEFAULT_IDLE_MS / 1000).describe('Stop after this long without a touch or key, once something was recorded.'),
    output: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('Absolute path of the *.nawi.yaml file to write, inside your home folder. Omit to only return the YAML.'),
    overwrite: z.boolean().default(false).describe('Replace an existing file at output.')
  }),
  async run(args, ctx) {
    // A bad output path is refused before anyone spends minutes recording.
    const out = args.output === undefined ? null : await prepareFlowOutput(args.output, args.overwrite)
    const stop = new AbortController()
    const off = settings.onSettingsChanged((next) => {
      if (next.agentAccessPaused) stop.abort(agentAccessPaused())
    })
    try {
      if ((await settings.getSettings()).agentAccessPaused) throw agentAccessPaused()
      let reads = 0
      const r = await recordAndroidLive({
        target: args.target ?? null,
        package: args.package ?? null,
        launch: args.launch,
        name: args.name,
        maxMs: args.max_seconds * 1000,
        idleMs: args.idle_seconds * 1000,
        signal: ctx.signal ? AbortSignal.any([stop.signal, ctx.signal]) : stop.signal,
        onReady: ctx.progress ? (inputs) => ctx.progress?.({ progress: ++reads, message: `screen read after ${inputs} inputs: ready for the next touch` }) : undefined
      })
      let file: string | null = null
      let saveError: string | null = null
      if (r.ok && r.flow_yaml !== null && out !== null) {
        try {
          file = await writeFlowOutput(out, r.flow_yaml)
        } catch (err) {
          // The recording is the answer: a file that appeared meanwhile (or a full disk) loses only the saved copy.
          saveError = `the flow could not be written: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      return {
        ok: r.ok,
        error: r.error,
        fix: r.fix,
        target: r.target,
        package: r.package,
        launched: r.launched,
        stopped: r.stopped,
        inputs: r.inputs,
        steps: r.flow?.steps.length ?? 0,
        warnings: r.warnings,
        flow_yaml: r.flow_yaml,
        file,
        save_error: saveError
      }
    } finally {
      off()
    }
  }
})

/** The FR-AGT.1 surface, in the order the requirement lists them. */
export const TOOLS: ToolDefinition[] = [
  captureScreen,
  captureRegion,
  captureElement,
  startRecording,
  stopRecording,
  getCapture,
  getStateLayer,
  listCaptures,
  searchCaptures,
  annotate,
  redact,
  exportGuide,
  exportFlow,
  runFlow,
  listRunsTool,
  getRun,
  getHealProposals,
  applyHealTool,
  inspectApk,
  mobileDoctor,
  mobileOpen,
  mobileStudy,
  mobileExplore,
  mobileRecord
]

export const TOOL_NAMES = TOOLS.map((t) => t.name)
