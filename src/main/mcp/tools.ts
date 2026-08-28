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
import { ToolError, notImplemented } from './errors'
import { PROJECTABLE_FIELDS, project, MAX_RESPONSE_BYTES } from './projection'
import { carryForwardFiles } from './revision'

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

function displayFor(displayId?: number): Electron.Display {
  if (typeof displayId === 'number') return capture.displayById(displayId)
  return screen.getPrimaryDisplay()
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
    'A source that was never harvested is reported as unavailable with a reason, not omitted.',
  idempotent: false,
  schema: z.object({
    capture_id: z.string().min(1).max(200),
    revision: z.string().max(16).optional().describe('e.g. "v1". Defaults to the current revision.'),
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
  exportGuide
]

export const TOOL_NAMES = TOOLS.map((t) => t.name)
