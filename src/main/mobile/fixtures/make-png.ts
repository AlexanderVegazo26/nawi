import { crc32, deflateSync } from 'node:zlib'
import { PNG_SIGNATURE as SIGNATURE, type RgbImage } from '../png'

/**
 * A PNG writer for tests (screenshots with known colours, and broken files a device would never send), so png.ts and
 * the contrast check are tested against bytes built here rather than checked-in images.
 */

export function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

export const PNG_SIGNATURE = Buffer.from(SIGNATURE)

export function ihdr(width: number, height: number, depth: number, colorType: number, interlace = 0): Buffer {
  const b = Buffer.alloc(13)
  b.writeUInt32BE(width, 0)
  b.writeUInt32BE(height, 4)
  b.set([depth, colorType, 0, 0, interlace], 8)
  return chunk('IHDR', b)
}

/** A PNG from unfiltered scanlines (`rowBytes` each), every row written with filter 0. */
export function pngFromRows(width: number, height: number, depth: number, colorType: number, rows: Uint8Array[], extra: Buffer[] = []): Uint8Array {
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r])))
  return Buffer.concat([PNG_SIGNATURE, ihdr(width, height, depth, colorType), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())])
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * An 8-bit RGB (or RGBA, alpha 255) PNG of `image`, as screencap writes one. Row y uses filter `filters[y % n]`
 * (default: cycle through all five), so every filter is exercised; IDAT is split in `idatChunks` pieces.
 */
export function encodePng(image: RgbImage, opts: { alpha?: boolean; filters?: number[]; idatChunks?: number } = {}): Uint8Array {
  const { width, height, rgb } = image
  const channels = opts.alpha ? 4 : 3
  const filters = opts.filters ?? [0, 1, 2, 3, 4]
  const rowBytes = width * channels
  const out = Buffer.alloc(height * (rowBytes + 1))
  let prev = new Uint8Array(rowBytes)
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(rowBytes)
    for (let x = 0; x < width; x++) {
      row.set(rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3), x * channels)
      if (opts.alpha) row[x * channels + 3] = 255
    }
    const f = filters[y % filters.length]
    const o = y * (rowBytes + 1)
    out[o] = f
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= channels ? row[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c)
      out[o + 1 + i] = (row[i] - pred) & 0xff
    }
    prev = row
  }
  const z = deflateSync(out)
  const n = Math.max(1, opts.idatChunks ?? 1)
  const size = Math.ceil(z.length / n)
  const idats: Buffer[] = []
  for (let k = 0; k < z.length; k += size) idats.push(chunk('IDAT', z.subarray(k, k + size)))
  return Buffer.concat([PNG_SIGNATURE, ihdr(width, height, 8, opts.alpha ? 6 : 2), ...idats, chunk('IEND', new Uint8Array())])
}

export type Colour = readonly [number, number, number]

/** A blank screen in one colour, with helpers to paint boxes and fake text on it. */
export function canvas(width: number, height: number, fill: Colour): RgbImage & {
  rect: (left: number, top: number, right: number, bottom: number, c: Colour) => void
  /** Fake glyphs inside the box: vertical strokes 4 px wide every 12 px, with a 1 px anti-aliased edge in `edge`. */
  text: (left: number, top: number, right: number, bottom: number, c: Colour, edge?: Colour) => void
} {
  const rgb = new Uint8Array(width * height * 3)
  for (let k = 0; k < width * height; k++) rgb.set(fill, k * 3)
  const set = (x: number, y: number, c: Colour): void => {
    if (x >= 0 && y >= 0 && x < width && y < height) rgb.set(c, (y * width + x) * 3)
  }
  const rect = (l: number, t: number, r: number, b: number, c: Colour): void => {
    for (let y = t; y < b; y++) for (let x = l; x < r; x++) set(x, y, c)
  }
  const text = (l: number, t: number, r: number, b: number, c: Colour, edge?: Colour): void => {
    const top = t + Math.floor((b - t) / 4)
    const bottom = b - Math.floor((b - t) / 4)
    for (let x = l + 8; x + 4 < r - 8; x += 12) {
      rect(x, top, x + 4, bottom, c)
      if (edge) {
        rect(x - 1, top, x, bottom, edge)
        rect(x + 4, top, x + 5, bottom, edge)
      }
    }
  }
  return { width, height, rgb, rect, text }
}
