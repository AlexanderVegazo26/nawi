import { crc32, deflateSync, inflateSync } from 'node:zlib'

/**
 * A PNG decoder for the screenshots a device returns (`screencap -p`: 8-bit RGBA, not interlaced), so the screen
 * study can read the colours under each text (roadmap M3b2) without a new dependency: node:zlib inflates, this file
 * checks the chunks and undoes the row filters. It reads every non-interlaced PNG the format allows (grey, RGB,
 * palette, grey + alpha, RGBA; 1-16 bits), drops alpha (a screenshot is opaque) and returns 8-bit RGB.
 *
 * The bytes come from a device the user plugged in, so nothing is trusted: every chunk length and CRC is checked,
 * the image is capped at MAX_PNG_PIXELS, and inflating stops at the exact size the header promises.
 */

export interface RgbImage {
  width: number
  height: number
  /** width * height * 3 bytes, row by row, r g b. */
  rgb: Uint8Array
}

export type PngResult = { ok: true; image: RgbImage } | { ok: false; error: string }

/** 40 million pixels: well above any phone or tablet screen (a 4K screen is 8.3 million). */
export const MAX_PNG_PIXELS = 40_000_000

export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Bit depths each colour type allows (PNG spec, table 11.1), and its samples per pixel. */
const COLOR_TYPES: Record<number, { depths: number[]; channels: number }> = {
  0: { depths: [1, 2, 4, 8, 16], channels: 1 },
  2: { depths: [8, 16], channels: 3 },
  3: { depths: [1, 2, 4, 8], channels: 1 },
  4: { depths: [8, 16], channels: 2 },
  6: { depths: [8, 16], channels: 4 }
}

const fail = (error: string): PngResult => ({ ok: false, error })

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function decodePng(bytes: Uint8Array): PngResult {
  if (bytes.length < 8 || PNG_SIGNATURE.some((v, k) => bytes[k] !== v)) return fail('not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let header: { width: number; height: number; depth: number; type: number } | null = null
  let palette: Uint8Array | null = null
  const data: Uint8Array[] = []
  let ended = false
  for (let at = 8; at < bytes.length && !ended; ) {
    if (at + 12 > bytes.length) return fail('truncated chunk header')
    const length = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    const end = at + 8 + length
    if (length > 0x7fffffff || end + 4 > bytes.length) return fail(`truncated ${type.replace(/[^\x20-\x7e]/g, '?')} chunk`)
    if (crc32(bytes.subarray(at + 4, end)) !== view.getUint32(end)) return fail(`bad CRC in the ${type.replace(/[^\x20-\x7e]/g, '?')} chunk`)
    const body = bytes.subarray(at + 8, end)
    if (header === null && type !== 'IHDR') return fail('the first chunk is not IHDR')
    if (type === 'IHDR') {
      if (header !== null) return fail('two IHDR chunks')
      if (length !== 13) return fail('IHDR is not 13 bytes')
      const width = view.getUint32(at + 8)
      const height = view.getUint32(at + 12)
      const [depth, colorType, compression, filter, interlace] = body.subarray(8, 13)
      if (width === 0 || height === 0) return fail('zero-sized image')
      if (width * height > MAX_PNG_PIXELS) return fail(`${width}x${height} is over the ${MAX_PNG_PIXELS} pixel limit`)
      const kind = COLOR_TYPES[colorType]
      if (!kind || !kind.depths.includes(depth)) return fail(`colour type ${colorType} at ${depth} bits is not a valid PNG format`)
      if (compression !== 0 || filter !== 0) return fail('unknown compression or filter method')
      if (interlace !== 0) return fail('interlaced PNGs are not read (a device screenshot never is)')
      header = { width, height, depth, type: colorType }
    } else if (type === 'PLTE') {
      if (length === 0 || length % 3 !== 0 || length > 768) return fail('bad palette')
      palette = body
    } else if (type === 'IDAT') {
      data.push(body)
    } else if (type === 'IEND') {
      ended = true
    } else if ((bytes[at + 4] & 0x20) === 0) {
      // An uppercase first letter marks a chunk a decoder must understand to show the image.
      return fail(`unknown critical chunk ${type.replace(/[^\x20-\x7e]/g, '?')}`)
    }
    at = end + 4
  }
  if (header === null) return fail('no IHDR chunk')
  if (data.length === 0) return fail('no image data')
  if (header.type === 3 && palette === null) return fail('palette image without a palette')

  const { width, height, depth, type } = header
  const channels = COLOR_TYPES[type].channels
  const bitsPerPixel = channels * depth
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8)
  const expected = height * (rowBytes + 1)
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected })
  } catch (err) {
    const tooBig = err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
    return fail(tooBig ? 'more image data than the header says' : `image data does not inflate (${(err as Error).message})`)
  }
  if (raw.length !== expected) return fail(`image data is ${raw.length} bytes, the header says ${expected}`)

  // Undo the per-row filters in place; bpp = bytes per complete pixel (at least 1) for the left neighbour.
  const bpp = Math.max(1, bitsPerPixel >> 3)
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1)
    const filter = raw[row]
    const cur = row + 1
    const prev = cur - (rowBytes + 1)
    if (filter > 4) return fail(`unknown row filter ${filter} on row ${y}`)
    // One loop per filter (a branch per byte is several times slower on a 10 MB screenshot); the row above row 0
    // and the pixel left of the first are zeros.
    const up = y > 0
    if (filter === 1) {
      for (let x = bpp; x < rowBytes; x++) raw[cur + x] = (raw[cur + x] + raw[cur + x - bpp]) & 0xff
    } else if (filter === 2) {
      if (up) for (let x = 0; x < rowBytes; x++) raw[cur + x] = (raw[cur + x] + raw[prev + x]) & 0xff
    } else if (filter === 3) {
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? raw[cur + x - bpp] : 0
        const b = up ? raw[prev + x] : 0
        raw[cur + x] = (raw[cur + x] + ((a + b) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? raw[cur + x - bpp] : 0
        const b = up ? raw[prev + x] : 0
        const c = up && x >= bpp ? raw[prev + x - bpp] : 0
        raw[cur + x] = (raw[cur + x] + paeth(a, b, c)) & 0xff
      }
    }
  }

  const rgb = new Uint8Array(width * height * 3)
  const maxSample = (1 << depth) - 1
  const sample = (row: number, s: number): number => {
    // The s-th sample of a row, scaled to 0..255 (16-bit keeps its high byte).
    if (depth === 8) return raw[row + s]
    if (depth === 16) return raw[row + 2 * s]
    const bit = s * depth
    const v = (raw[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & maxSample
    return type === 3 ? v : Math.round((v * 255) / maxSample)
  }
  if (depth === 8 && (type === 2 || type === 6)) {
    // What a device sends (screencap: 8-bit RGBA): a straight copy, alpha dropped.
    for (let y = 0; y < height; y++) {
      let i = y * (rowBytes + 1) + 1
      let o = y * width * 3
      for (let x = 0; x < width; x++, i += channels, o += 3) {
        rgb[o] = raw[i]
        rgb[o + 1] = raw[i + 1]
        rgb[o + 2] = raw[i + 2]
      }
    }
    return { ok: true, image: { width, height, rgb } }
  }
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1) + 1
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3
      if (type === 2 || type === 6) {
        rgb[o] = sample(row, x * channels)
        rgb[o + 1] = sample(row, x * channels + 1)
        rgb[o + 2] = sample(row, x * channels + 2)
      } else if (type === 3) {
        const k = depth === 8 ? raw[row + x] : sample(row, x)
        const p = palette as Uint8Array
        if (k * 3 + 2 >= p.length) return fail(`palette index ${k} is past the palette`)
        rgb[o] = p[k * 3]
        rgb[o + 1] = p[k * 3 + 1]
        rgb[o + 2] = p[k * 3 + 2]
      } else {
        const g = sample(row, x * channels)
        rgb[o] = g
        rgb[o + 1] = g
        rgb[o + 2] = g
      }
    }
  }
  return { ok: true, image: { width, height, rgb } }
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/**
 * An 8-bit RGB PNG of `image` (lossless, every row with the Sub filter, which suits flat UI pixels), e.g. a
 * reference crop the replayer later reads back with decodePng.
 */
export function encodePng(image: RgbImage): Uint8Array {
  const { width, height, rgb } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgb.length !== width * height * 3) {
    throw new RangeError(`encodePng: ${width}x${height} image with ${rgb.length} bytes of RGB`)
  }
  const rowBytes = width * 3
  const raw = Buffer.alloc(height * (rowBytes + 1))
  for (let y = 0; y < height; y++) {
    const o = y * (rowBytes + 1)
    const row = y * rowBytes
    raw[o] = 1
    for (let i = 0; i < rowBytes; i++) raw[o + 1 + i] = (rgb[row + i] - (i >= 3 ? rgb[row + i - 3] : 0)) & 0xff
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array())
  ])
}
