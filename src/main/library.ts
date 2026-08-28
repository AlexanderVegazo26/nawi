import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AnnotationDoc, CaptureKind, LibraryItem, MediaKind } from '@shared/types'

/**
 * Flat-file library store.
 *
 * Assets live as individual files under userData; a single index.json holds the
 * records. A database would buy us nothing here — the working set is small,
 * writes are user-paced, and a plain JSON index stays inspectable and trivially
 * recoverable if it is ever corrupted. It also keeps us free of native modules.
 */

const root = (): string => join(app.getPath('userData'), 'library')
const assetsDir = (): string => join(root(), 'assets')
const indexPath = (): string => join(root(), 'index.json')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let cache: LibraryItem[] | null = null
/** Serializes index writes so concurrent saves can't interleave and lose records. */
let writeChain: Promise<unknown> = Promise.resolve()

async function ensureDirs(): Promise<void> {
  await fs.mkdir(assetsDir(), { recursive: true })
}

async function readIndex(): Promise<LibraryItem[]> {
  if (cache) return cache
  await ensureDirs()
  try {
    const raw = await fs.readFile(indexPath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    cache = Array.isArray(parsed) ? (parsed as LibraryItem[]) : []
  } catch {
    // Missing or unreadable index is the normal first-run case.
    cache = []
  }
  return cache
}

function writeIndex(items: LibraryItem[]): Promise<void> {
  cache = items
  writeChain = writeChain.then(async () => {
    await ensureDirs()
    const tmp = `${indexPath()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf-8')
    // Atomic-ish replace, so a crash mid-write can't truncate the index.
    await fs.rename(tmp, indexPath())
  })
  return writeChain as Promise<void>
}

function defaultName(kind: MediaKind, when: Date): string {
  const stamp = when.toISOString().replace(/[:.]/g, '-').replace('T', ' ').slice(0, 19)
  return `${kind === 'video' ? 'Recording' : 'Capture'} ${stamp}`
}

export interface SaveArgs {
  kind: MediaKind
  captureKind: CaptureKind
  bytes: Buffer
  width: number
  height: number
  durationMs?: number
  name?: string
}

export async function listItems(): Promise<LibraryItem[]> {
  const items = await readIndex()
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function save(args: SaveArgs): Promise<LibraryItem> {
  await ensureDirs()
  const id = randomUUID()
  const now = new Date()
  const ext = args.kind === 'video' ? 'webm' : 'png'
  const filePath = join(assetsDir(), `${id}.${ext}`)
  await fs.writeFile(filePath, args.bytes)

  const item: LibraryItem = {
    id,
    name: args.name?.trim() || defaultName(args.kind, now),
    kind: args.kind,
    captureKind: args.captureKind,
    filePath,
    width: args.width,
    height: args.height,
    size: args.bytes.byteLength,
    durationMs: args.durationMs ?? null,
    createdAt: now.toISOString(),
    annotations: null
  }

  const items = await readIndex()
  await writeIndex([item, ...items])
  return item
}

/** Ids arrive from the renderer, so they are validated and resolved through the index — never used as a path segment. */
export async function getItem(id: string): Promise<LibraryItem | undefined> {
  if (!UUID_RE.test(id)) return undefined
  const items = await readIndex()
  return items.find((i) => i.id === id)
}

async function requireItem(id: string): Promise<LibraryItem> {
  const item = await getItem(id)
  if (!item) throw new Error('That capture no longer exists')
  return item
}

export async function deleteItem(id: string): Promise<void> {
  const target = await getItem(id)
  if (!target) return
  const items = await readIndex()
  await writeIndex(items.filter((i) => i.id !== id))
  // Best-effort asset cleanup — a missing file must not fail the delete.
  await fs.rm(target.filePath, { force: true }).catch(() => undefined)
}

async function update(id: string, patch: Partial<LibraryItem>): Promise<LibraryItem> {
  await requireItem(id)
  const items = await readIndex()
  const idx = items.findIndex((i) => i.id === id)
  const updated: LibraryItem = { ...items[idx], ...patch }
  const next = [...items]
  next[idx] = updated
  await writeIndex(next)
  return updated
}

export async function renameItem(id: string, name: string): Promise<LibraryItem> {
  const current = await requireItem(id)
  return update(id, { name: name.trim() || current.name })
}

export async function saveAnnotations(id: string, doc: AnnotationDoc): Promise<LibraryItem> {
  return update(id, { annotations: doc })
}

export async function readItemBytes(id: string): Promise<{ bytes: Buffer; mime: string }> {
  const item = await requireItem(id)
  const bytes = await fs.readFile(item.filePath)
  return { bytes, mime: item.kind === 'video' ? 'video/webm' : 'image/png' }
}
