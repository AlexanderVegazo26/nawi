import { inflateRawSync } from 'node:zlib'
import { ApkError, corrupt } from './errors'

/**
 * Just enough of a zip reader for an APK: the central directory and one entry's bytes, read with positioned reads so
 * a 200 MB APK costs a few kilobytes of memory. Stored and deflated entries only (the two methods APKs use); zip64
 * and encrypted entries are refused with a reason. Every offset is bounds-checked: the input is untrusted.
 */

/** Random access to the archive bytes (a file handle in production, a buffer in tests). */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > bytes.length) throw corrupt('a zip record points past the end of the file')
      return bytes.subarray(offset, offset + length)
    }
  }
}

export interface ZipEntry {
  name: string
  method: number
  flags: number
  compressedSize: number
  size: number
  localHeaderOffset: number
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff
/** A central directory this large is ~500k entries: far past any real APK, and a cheap memory bound. */
export const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength)
const zip64 = (): ApkError =>
  new ApkError('unsupported', 'This APK uses the zip64 format, which Nawi cannot read yet.', 'Rebuild it without zip64 (fewer than 65535 files, under 4 GB).')
/** Deflate never grows data by more than ~0.1% + a few bytes; anything past this is not an honest entry. */
const maxCompressed = (maxBytes: number): number => maxBytes + (maxBytes >> 9) + 1024

export async function readCentralDirectory(src: ByteSource): Promise<ZipEntry[]> {
  if (src.size < EOCD_MIN) throw corrupt('it is too small to be a zip archive')
  const tailLen = Math.min(src.size, EOCD_MIN + MAX_COMMENT)
  const tail = await src.read(src.size - tailLen, tailLen)
  const tv = view(tail)
  let at = -1
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD_SIG && i + EOCD_MIN + tv.getUint16(i + 20, true) <= tail.length) {
      at = i
      break
    }
  }
  if (at < 0) throw corrupt('no zip directory at the end of the file (not a zip archive, or cut short)')
  const count = tv.getUint16(at + 10, true)
  const cdSize = tv.getUint32(at + 12, true)
  const cdOffset = tv.getUint32(at + 16, true)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw zip64()
  if (cdSize > MAX_CENTRAL_DIRECTORY) throw corrupt(`its zip directory claims ${cdSize} bytes`)
  if (cdOffset + cdSize > src.size) throw corrupt('its zip directory points past the end of the file')
  const cd = await src.read(cdOffset, cdSize)
  const cv = view(cd)
  const entries: ZipEntry[] = []
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== CD_SIG) throw corrupt(`zip directory entry ${i} is damaged`)
    const nameLen = cv.getUint16(p + 28, true)
    const extraLen = cv.getUint16(p + 30, true)
    const commentLen = cv.getUint16(p + 32, true)
    if (p + 46 + nameLen > cd.length) throw corrupt(`zip directory entry ${i} has a name past the directory's end`)
    const entry: ZipEntry = {
      flags: cv.getUint16(p + 8, true),
      method: cv.getUint16(p + 10, true),
      compressedSize: cv.getUint32(p + 20, true),
      size: cv.getUint32(p + 24, true),
      localHeaderOffset: cv.getUint32(p + 42, true),
      name: decoder.decode(cd.subarray(p + 46, p + 46 + nameLen))
    }
    // 0xffffffff means "the real value is in the zip64 extra field": the same zip64 refusal as the EOCD check.
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.localHeaderOffset === 0xffffffff) throw zip64()
    entries.push(entry)
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** The uncompressed bytes of one entry, refusing anything over `maxBytes` (a zip bomb costs nothing to make). */
export async function readEntry(src: ByteSource, entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
  if (entry.flags & 1) throw new ApkError('unsupported', `${entry.name} is encrypted inside the archive.`, 'Use an unencrypted build of the app.')
  if (entry.size > maxBytes) throw corrupt(`${entry.name} is ${entry.size} bytes, over the ${maxBytes}-byte limit`)
  // Checked before reading: the compressed size is what gets allocated, whatever the declared size says.
  if (entry.compressedSize > maxCompressed(maxBytes)) throw corrupt(`${entry.name} claims ${entry.compressedSize} compressed bytes, over the limit`)
  if (entry.method === 0 && entry.compressedSize !== entry.size) throw corrupt(`${entry.name} is stored uncompressed but its two sizes differ`)
  if (entry.localHeaderOffset + 30 > src.size) throw corrupt(`${entry.name} starts past the end of the file`)
  const head = view(await src.read(entry.localHeaderOffset, 30))
  if (head.getUint32(0, true) !== LOCAL_SIG) throw corrupt(`${entry.name} has a damaged local header`)
  const start = entry.localHeaderOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true)
  if (start + entry.compressedSize > src.size) throw corrupt(`${entry.name} runs past the end of the file`)
  const data = await src.read(start, entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method !== 8) throw new ApkError('unsupported', `${entry.name} uses zip compression method ${entry.method}.`, 'Rebuild the APK with the standard Android build tools (stored or deflated entries).')
  try {
    return inflateRawSync(data, { maxOutputLength: maxBytes })
  } catch {
    throw corrupt(`${entry.name} does not decompress`)
  }
}
