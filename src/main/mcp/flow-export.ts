import { flowFromRecording, stringifyFlow, FLOW_FILE_SUFFIX, type Flow, type FlowTarget, type SkipReason } from '@shared/flow'
import type { SidecarRead, UnavailableReason } from '@shared/sidecar/types'
import { access, constants, link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isNdjsonRef } from '@shared/sidecar/types'
import { insideRoots, within } from '../confine'
import { FILE_PATHS } from '../harvest/harvest'
import { PNG_SIGNATURE } from '../mobile/png'
import { MAX_ANCHOR_BYTES } from '../replay/replay'
import { isSafeRelPath } from '../sidecar/paths'
import { ToolError } from './errors'
import { readEntries } from './projection'

/**
 * `export_flow`'s work, kept free of Electron so it can be tested against a real
 * revision directory: read a revision's input events (NDJSON side file or the
 * inline DC-4 array) and turn them into flow YAML; with an output path, write
 * that file and the steps' reference crops next to it (roadmap AI1).
 */

/** Where the harvest writes a click's reference crop inside a revision (sidecar 1.2). */
const CROP_SOURCE_RE = new RegExp(`^${FILE_PATHS.crops}/(\\d{6})\\.png$`)
/** A crop file the export writes into its crops folder (and may replace on overwrite). */
const CROP_FILE_RE = /^\d{6}\.png$/

/**
 * The most input events one export reads. The harvest keeps at most 50 000 per
 * recording, so this only bites on a hand-made or foreign sidecar, where it
 * bounds memory; the reply then says the flow covers only the start.
 */
export const MAX_EXPORT_EVENTS = 50_000

export class NoInputEventsError extends Error {
  /** `unreadable`: the sidecar names an events file that is missing, unreadable (or fails before any event is read) or outside the revision. */
  constructor(readonly reason: UnavailableReason | 'not_harvested' | 'unreadable') {
    super(`no input events (${reason})`)
  }
}

export interface FlowExport {
  revision: string
  /** The file name: a suggestion when nothing is written, else the written file's name. */
  file_name: string
  /** The flow file written (its real path), when an output path was given. */
  file?: string
  /** Reference crops written next to it, in `<name>.crops/`, one per step that has one. */
  crops?: number
  steps: number
  /** Input events read from the revision. */
  events: number
  merged: number
  skipped: Partial<Record<SkipReason, number>>
  warnings: string[]
  flow_yaml: string
}

export async function flowFromSidecar(options: {
  revisionDir: string
  sidecar: SidecarRead
  revision: string
  name?: string
  /** Absolute `*.nawi.yaml` path to write the flow to, with its crops; omitted = return the YAML only. */
  output?: string
  /** Replace an existing file at `output` (and the crops of an earlier export there). */
  overwrite?: boolean
  /** Folders `output` must be inside; defaults to the home directory. */
  roots?: string[]
  /** Tests only: a smaller cap than MAX_EXPORT_EVENTS. */
  maxEvents?: number
}): Promise<FlowExport> {
  // Refuse a bad output path before reading anything.
  const out = options.output === undefined ? undefined : await prepareOutput(options.output, options.overwrite === true, options.roots ?? [homedir()])
  const maxEvents = options.maxEvents ?? MAX_EXPORT_EVENTS
  const { sidecar } = options
  const source = sidecar.state_layer.input_events
  if (source === null) {
    const reason = sidecar.state_layer.unavailable.find((u) => u.source === 'input_events')?.reason
    throw new NoInputEventsError(reason ?? 'not_harvested')
  }

  // readEntries yields nothing for a file it can't open (get_state_layer reports
  // that as an empty page); an export would turn it into an empty flow that
  // looks like a recording with no input, so check the file first.
  if (isNdjsonRef(source as never)) {
    const path = (source as { path?: unknown }).path
    if (typeof path !== 'string' || !isSafeRelPath(path)) throw new NoInputEventsError('unreadable')
    try {
      await access(join(options.revisionDir, path), constants.R_OK)
    } catch {
      throw new NoInputEventsError('unreadable')
    }
  }

  const events: Record<string, unknown>[] = []
  let truncated = false
  let readError: unknown
  for await (const entry of readEntries(options.revisionDir, source, (err) => (readError = err))) {
    if (events.length >= maxEvents) {
      truncated = true
      break
    }
    events.push(entry)
  }
  // A read that failed (a directory, a disk error, a file cut short under the
  // reader) must not pass for a complete recording: with nothing read it is the
  // same as a missing file, otherwise the flow is kept and the gap is a warning.
  if (readError !== undefined && events.length === 0) throw new NoInputEventsError('unreadable')

  const surface = sidecar.surface
  const hasUrl = typeof surface.url === 'string' && /\S/.test(surface.url)
  // A browser recording that didn't save its start page is still a browser flow:
  // its steps use page selectors, which a desktop target can never replay.
  const missingStartUrl = !hasUrl && surface.type === 'browser'
  const target: FlowTarget = hasUrl
    ? { kind: 'browser', url: surface.url as string }
    : missingStartUrl
      ? { kind: 'browser', url: 'about:blank' }
      : { kind: 'desktop', app: /\S/.test(surface.app) ? surface.app : 'unknown' }
  const name = options.name && /\S/.test(options.name) ? options.name : `Recording ${sidecar.created_at}`
  // Crops are only kept when they are written: a YAML-only answer has nowhere for them to live.
  const cropSources = new Map<string, string>()
  const result = flowFromRecording(events, {
    name,
    target,
    ...(out
      ? {
          image: (recorded: string) => {
            const m = CROP_SOURCE_RE.exec(recorded)
            if (!m) return undefined
            const path = `${out.cropsDir}/${m[1]}.png`
            cropSources.set(path, recorded)
            return path
          }
        }
      : {})
  })
  const { crops, dropped } = out ? await readCrops(options.revisionDir, result.flow, cropSources) : { crops: new Map<string, Uint8Array>(), dropped: 0 }

  const warnings = [
    ...(truncated
      ? [`Only the first ${maxEvents} input events were read; the flow covers the start of the recording only.`]
      : []),
    ...(readError !== undefined
      ? [
          `Reading the input events failed after ${events.length} events (${errorCode(readError)}); ` +
            'the flow covers the start of the recording only.'
        ]
      : []),
    ...(missingStartUrl
      ? [
          "The recording didn't save the page it started on, so the flow starts on about:blank; " +
            'set target.url to that page before replaying.'
        ]
      : []),
    ...result.warnings,
    ...(dropped > 0
      ? [
          `${dropped} step${dropped === 1 ? "'s" : "s'"} reference crop ` +
            "could not be read from the capture, so those steps have no image (they still replay by their locators)."
        ]
      : [])
  ]

  const flowYaml = stringifyFlow(result.flow)
  if (out) await writeExport(out, flowYaml, crops)
  return {
    revision: options.revision,
    file_name: out ? basename(out.file) : `${fileSlug(name)}${FLOW_FILE_SUFFIX}`,
    ...(out ? { file: out.file, crops: crops.size } : {}),
    steps: result.flow.steps.length,
    events: events.length,
    merged: result.merged,
    skipped: result.skipped,
    warnings,
    flow_yaml: flowYaml
  }
}

interface Output {
  /** Path of the flow file to write: its folder resolved, the file itself never followed. */
  file: string
  folder: string
  /** The crops folder, relative to the flow file. */
  cropsDir: string
  overwrite: boolean
}

/**
 * The crops folder for a flow file: `<stem>.crops`, the file name without its
 * suffix, so two flows in one folder never share one. A stem a flow can't name
 * as an asset path (`%`, control characters) gets a readable slug plus a hash
 * of the stem, which stays unique.
 */
function cropsDirFor(file: string): string {
  const stem = basename(file).slice(0, -FLOW_FILE_SUFFIX.length)
  if (!/[%\u0000-\u001f\u007f\\/:]/.test(stem) && stem !== '.' && stem !== '..' && !stem.startsWith('.')) return `${stem}.crops`
  return `${fileSlug(stem)}-${createHash('sha256').update(stem).digest('hex').slice(0, 8)}.crops`
}

/**
 * Where an export may write: an absolute `*.nawi.yaml` path inside a root (the
 * home directory, like the files `run_flow` reads; checked on the path as given
 * before anything on disk is looked at, then on its resolved folder), whose
 * folder exists, that is not a link or a non-file, and not an existing file
 * unless `overwrite`. Its crops folder must not be a link and, without
 * `overwrite`, must not already hold crops. writeExport checks again when it
 * moves files into place.
 */
async function prepareOutput(file: string, overwrite: boolean, roots: string[]): Promise<Output> {
  if (!isAbsolute(file)) {
    throw new ToolError('INVALID_ARGUMENTS', 'output must be an absolute path for the flow file.', { output: file })
  }
  if (!file.endsWith(FLOW_FILE_SUFFIX) || basename(file) === FLOW_FILE_SUFFIX) {
    throw new ToolError('INVALID_ARGUMENTS', `output must name a flow file (*${FLOW_FILE_SUFFIX}).`, { output: file })
  }
  const outside = (): ToolError =>
    new ToolError(
      'INVALID_ARGUMENTS',
      `Flow files must be written inside ${roots.length === 1 ? 'your home directory' : 'an allowed folder'}.`,
      { output: file }
    )
  if (!(await insideRoots(file, roots, true))) throw outside()
  let folder: string
  try {
    folder = await realpath(dirname(file))
  } catch {
    throw new ToolError('NOT_FOUND', 'The folder for the flow file does not exist.', { output: file })
  }
  const target = join(folder, basename(file))
  if (!(await insideRoots(target, roots))) throw outside()
  const existing = await lstat(target).catch(() => null)
  if (existing && !existing.isFile()) {
    throw new ToolError('INVALID_ARGUMENTS', 'Something other than a regular file (a folder or a link) is at output; nothing was written.', { output: file })
  }
  if (existing && !overwrite) throw fileExists(file)
  const cropsDir = cropsDirFor(target)
  const dir = await lstat(join(folder, cropsDir)).catch(() => null)
  if (dir && !dir.isDirectory()) throw cropsNotFolder(cropsDir)
  if (dir && !overwrite && (await holdsCrops(join(folder, cropsDir)))) throw cropsExist(cropsDir)
  return { file: target, folder, cropsDir, overwrite }
}

const fileExists = (output: string): ToolError =>
  new ToolError('INVALID_ARGUMENTS', 'A file already exists at output; pass overwrite: true to replace it.', { output, exists: true })
const cropsNotFolder = (cropsDir: string): ToolError =>
  new ToolError('INVALID_ARGUMENTS', `${cropsDir} next to output is not a folder (or is a link); nothing was written.`, { crops_dir: cropsDir })
const cropsExist = (cropsDir: string): ToolError =>
  new ToolError('INVALID_ARGUMENTS', `${cropsDir} next to output already holds crops; pass overwrite: true to replace them.`, { crops_dir: cropsDir, exists: true })

async function holdsCrops(dir: string): Promise<boolean> {
  return (await readdir(dir)).some((f) => CROP_FILE_RE.test(f))
}

/**
 * The most crops (and crop bytes) one export copies: the harvest keeps at most
 * 300 / 32 MiB per recording, so this only bites on a forged sidecar, where it
 * bounds memory. Steps past it keep their locators without an image.
 */
export const MAX_EXPORT_CROPS = 300
export const MAX_EXPORT_CROP_BYTES = 32 * 1024 * 1024

/**
 * The crops the flow's steps point at, read from the revision: each source
 * must be the harvest's `input_crops/NNNNNN.png`, resolve inside the
 * revision, be a regular file no larger than the replayer accepts, start with
 * the PNG signature, and fit the export's caps. A step whose crop fails any of
 * that loses its `image` (in `flow`); the replayer still decodes the rest.
 */
async function readCrops(
  revisionDir: string,
  flow: Flow,
  sources: Map<string, string>
): Promise<{ crops: Map<string, Uint8Array>; dropped: number }> {
  const out = new Map<string, Uint8Array>()
  const bad = new Set<string>()
  let bytes = 0
  const revision = await realpath(revisionDir).catch(() => null)
  for (const step of flow.steps) {
    const target = 'target' in step ? step.target : undefined
    const path = target?.image
    if (target === undefined || path === undefined || out.has(path)) continue
    const crop =
      bad.has(path) || revision === null || out.size >= MAX_EXPORT_CROPS ? null : await readCrop(revision, sources.get(path))
    if (crop && bytes + crop.length <= MAX_EXPORT_CROP_BYTES) {
      out.set(path, crop)
      bytes += crop.length
    } else {
      bad.add(path)
      delete target.image
    }
  }
  return { crops: out, dropped: bad.size }
}

async function readCrop(revision: string, source: string | undefined): Promise<Uint8Array | null> {
  // The pattern admits only `input_crops/NNNNNN.png`: a safe relative path by construction.
  if (source === undefined || !CROP_SOURCE_RE.test(source)) return null
  let real: string
  try {
    real = await realpath(join(revision, source))
  } catch {
    return null
  }
  if (!within(revision, real)) return null
  try {
    // Not blocking on open: a FIFO swapped in for the crop would otherwise hang the export.
    const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_ANCHOR_BYTES) return null
      const bytes = new Uint8Array(await handle.readFile())
      return bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v) ? bytes : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * Puts the flow and its crops in place so no flow on disk ever points at a
 * crop that isn't its own, also when this fails half way or races another
 * export:
 *  1. The crops and the YAML are written under temporary names first (a new
 *     hidden folder, created exclusively; files opened with O_EXCL, so nothing
 *     is written through a link).
 *  2. Without overwrite, each crop is hard-linked into the crops folder (fails
 *     if the name is taken, never replaces) and so is the flow file.
 *  3. With overwrite, the old crops folder is moved aside, the new one renamed
 *     in, then the flow file renamed over the old one; if that fails, the old
 *     folder is moved back, so the old flow still has its own crops. Files in
 *     the old folder that aren't crops are carried over to the new one.
 * Temporary files are removed on every path.
 */
async function writeExport(out: Output, yaml: string, crops: Map<string, Uint8Array>): Promise<void> {
  const tag = randomBytes(6).toString('hex')
  const finalDir = join(out.folder, out.cropsDir)
  const newDir = join(out.folder, `.${out.cropsDir}.${tag}.new`)
  const oldDir = join(out.folder, `.${out.cropsDir}.${tag}.old`)
  const tempYaml = join(out.folder, `.${basename(out.file)}.${tag}.tmp`)
  const excl = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  const writeNew = async (path: string, data: Uint8Array | string): Promise<void> => {
    const handle = await open(path, excl, 0o644)
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
  }
  const linked: string[] = []
  let movedOld = false
  let movedNew = false
  /** Set once the new flow file is in place: from then on nothing is rolled back. */
  let placed = false
  try {
    await mkdir(newDir)
    for (const [path, bytes] of crops) await writeNew(join(newDir, basename(path)), bytes)
    await writeNew(tempYaml, yaml)

    const dir = await lstat(finalDir).catch(() => null)
    if (dir && !dir.isDirectory()) throw cropsNotFolder(out.cropsDir)
    if (!out.overwrite) {
      if (crops.size > 0) {
        if (dir && (await holdsCrops(finalDir))) throw cropsExist(out.cropsDir)
        if (!dir) await mkdir(finalDir).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err })
        if (!(await lstat(finalDir)).isDirectory()) throw cropsNotFolder(out.cropsDir)
        for (const path of crops.keys()) {
          const dest = join(finalDir, basename(path))
          await link(join(newDir, basename(path)), dest).catch((err: NodeJS.ErrnoException) => {
            throw err.code === 'EEXIST' ? cropsExist(out.cropsDir) : err
          })
          linked.push(dest)
        }
      }
      await link(tempYaml, out.file).catch((err: NodeJS.ErrnoException) => {
        throw err.code === 'EEXIST' ? fileExists(out.file) : err
      })
      return
    }

    const existing = await lstat(out.file).catch(() => null)
    if (existing && !existing.isFile()) throw new ToolError('INVALID_ARGUMENTS', 'Something other than a regular file (a folder or a link) is at output; nothing was written.', { output: out.file })
    if (dir) {
      await rename(finalDir, oldDir)
      movedOld = true
    }
    if (crops.size > 0) {
      await rename(newDir, finalDir)
      movedNew = true
    }
    await rename(tempYaml, out.file)
    placed = true
    if (movedOld) {
      // The new flow is in place: keep what else lived in the old folder, drop its crops.
      for (const f of await readdir(oldDir)) {
        if (CROP_FILE_RE.test(f)) continue
        if (!movedNew) {
          await mkdir(finalDir).catch(() => undefined)
          movedNew = true
        }
        await rename(join(oldDir, f), join(finalDir, f)).catch(() => undefined)
      }
      await rm(oldDir, { recursive: true, force: true })
    }
  } catch (err) {
    if (!placed) {
      for (const path of linked) await rm(path, { force: true })
      if (movedNew) await rm(finalDir, { recursive: true, force: true })
      if (movedOld) await rename(oldDir, finalDir).catch(() => undefined)
    }
    throw err
  } finally {
    await rm(newDir, { recursive: true, force: true })
    await rm(tempYaml, { force: true })
  }
}

/** A short, path-free label for a read error: its errno code when it has one. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'read error'
}

function fileSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return s || 'recording'
}
