import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { canvas, chunk, encodePng, ihdr, PNG_SIGNATURE, pngFromRows } from './fixtures/make-png'
import { decodePng, MAX_PNG_PIXELS, type RgbImage } from './png'

/**
 * The in-house PNG decoder the screen study reads screenshots with (roadmap M3b2). Every format a PNG may use
 * decodes to the same 8-bit RGB pixels, and every broken or hostile file a device could send is refused with a
 * reason instead of a crash or a huge allocation.
 */

/** A 7x5 image whose every pixel differs, so a wrong filter or offset shows up as a wrong pixel. */
function gradient(width = 7, height = 5): RgbImage {
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgb.set([(x * 37 + y * 11) & 0xff, (x * 5 + y * 53) & 0xff, (x * y * 29 + 7) & 0xff], (y * width + x) * 3)
  }
  return { width, height, rgb }
}

const decoded = (bytes: Uint8Array): RgbImage => {
  const r = decodePng(bytes)
  if (!r.ok) throw new Error(`decodePng refused a valid PNG: ${r.error}`)
  return r.image
}
const refusal = (bytes: Uint8Array): string => {
  const r = decodePng(bytes)
  if (r.ok) throw new Error(`decodePng accepted a broken PNG (${r.image.width}x${r.image.height})`)
  return r.error
}
const pixel = (img: RgbImage, x: number, y: number): number[] => Array.from(img.rgb.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3))

describe('decodePng: formats', () => {
  it.each([0, 1, 2, 3, 4])('undoes row filter %i exactly (RGB and RGBA)', (f) => {
    const img = gradient()
    for (const alpha of [false, true]) {
      expect(decoded(encodePng(img, { alpha, filters: [f] })), `filter ${f}, ${alpha ? 'RGBA' : 'RGB'}`).toEqual(img)
    }
  })

  it('decodes a screenshot-sized RGBA image with mixed filters split over many IDAT chunks', () => {
    const screen = canvas(108, 240, [250, 250, 250])
    screen.text(10, 20, 98, 60, [20, 20, 20], [120, 120, 120])
    const out = decoded(encodePng(screen, { alpha: true, idatChunks: 9 }))
    expect({ width: out.width, height: out.height }).toEqual({ width: 108, height: 240 })
    expect(Buffer.from(out.rgb).equals(Buffer.from(screen.rgb)), 'pixels differ after a round trip').toBe(true)
  })

  it('decodes grey (1, 2, 4, 8, 16 bit), grey + alpha, 16-bit RGB and palette images to 8-bit RGB', () => {
    // Grey 1 bit: 10110000 = white, black, white, white.
    expect(Array.from(decoded(pngFromRows(4, 1, 1, 0, [Uint8Array.of(0b10110000)])).rgb), 'grey 1 bit').toEqual([255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255])
    // Grey 2 bit: 0, 1, 2, 3 -> 0, 85, 170, 255.
    expect(Array.from(decoded(pngFromRows(4, 1, 2, 0, [Uint8Array.of(0b00011011)])).rgb).filter((_, k) => k % 3 === 0), 'grey 2 bit').toEqual([0, 85, 170, 255])
    // Grey 4 bit: 0x3 and 0xc -> 51 and 204.
    expect(Array.from(decoded(pngFromRows(2, 1, 4, 0, [Uint8Array.of(0x3c)])).rgb), 'grey 4 bit').toEqual([51, 51, 51, 204, 204, 204])
    expect(Array.from(decoded(pngFromRows(2, 1, 8, 0, [Uint8Array.of(9, 200)])).rgb), 'grey 8 bit').toEqual([9, 9, 9, 200, 200, 200])
    expect(Array.from(decoded(pngFromRows(1, 1, 16, 0, [Uint8Array.of(0xab, 0xcd)])).rgb), 'grey 16 bit keeps the high byte').toEqual([0xab, 0xab, 0xab])
    expect(Array.from(decoded(pngFromRows(2, 1, 8, 4, [Uint8Array.of(40, 255, 90, 0)])).rgb), 'grey + alpha drops alpha').toEqual([40, 40, 40, 90, 90, 90])
    expect(Array.from(decoded(pngFromRows(1, 1, 16, 2, [Uint8Array.of(1, 2, 3, 4, 5, 6)])).rgb), '16-bit RGB').toEqual([1, 3, 5])
    expect(Array.from(decoded(pngFromRows(1, 1, 16, 6, [Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)])).rgb), '16-bit RGBA').toEqual([1, 3, 5])
    const plte = chunk('PLTE', Uint8Array.of(255, 0, 0, 0, 0, 255, 10, 20, 30))
    expect(Array.from(decoded(pngFromRows(3, 1, 8, 3, [Uint8Array.of(2, 0, 1)], [plte])).rgb), 'palette 8 bit').toEqual([10, 20, 30, 255, 0, 0, 0, 0, 255])
    // Palette 2 bit: indexes 1, 2, 0.
    expect(Array.from(decoded(pngFromRows(3, 1, 2, 3, [Uint8Array.of(0b01100000)], [plte])).rgb), 'palette 2 bit').toEqual([0, 0, 255, 10, 20, 30, 255, 0, 0])
  })

  it('skips ancillary chunks it does not know (text, gamma, physical size)', () => {
    const img = gradient(3, 2)
    const plain = Buffer.from(encodePng(img))
    const withText = Buffer.concat([plain.subarray(0, 33), chunk('tEXt', Buffer.from('Software\0screencap')), chunk('pHYs', new Uint8Array(9)), plain.subarray(33)])
    expect(decoded(withText)).toEqual(img)
  })
})

describe('decodePng: refuses broken and hostile files with a reason', () => {
  const good = Buffer.from(encodePng(gradient()))

  it('refuses what is not a PNG or is cut short', () => {
    expect(refusal(new TextEncoder().encode('/system/bin/sh: screencap: not found\n'))).toBe('not a PNG')
    expect(refusal(good.subarray(0, 20))).toMatch(/truncated/)
    expect(refusal(good.subarray(0, good.length - 30)), 'IDAT cut').toMatch(/truncated|no image data|inflate/)
    expect(refusal(Buffer.concat([PNG_SIGNATURE, chunk('IEND', new Uint8Array())])), 'no IHDR').toMatch(/first chunk is not IHDR/)
    expect(refusal(Buffer.concat([PNG_SIGNATURE, ihdr(2, 2, 8, 2), chunk('IEND', new Uint8Array())]))).toBe('no image data')
  })

  it('refuses a chunk whose CRC is wrong (a corrupted transfer)', () => {
    const bad = Buffer.from(good)
    bad[45] ^= 0xff // inside the IDAT data (33..36 length, 37..40 type)
    expect(refusal(bad)).toMatch(/bad CRC in the IDAT chunk/)
  })

  it('refuses invalid headers: zero size, bad depth for the colour type, interlaced, unknown methods', () => {
    const only = (h: Buffer) => Buffer.concat([PNG_SIGNATURE, h, chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('IEND', new Uint8Array())])
    expect(refusal(only(ihdr(0, 5, 8, 2)))).toBe('zero-sized image')
    expect(refusal(only(ihdr(2, 2, 4, 2))), 'RGB at 4 bits').toMatch(/colour type 2 at 4 bits/)
    expect(refusal(only(ihdr(2, 2, 8, 5))), 'colour type 5').toMatch(/colour type 5/)
    expect(refusal(only(ihdr(2, 2, 8, 2, 1)))).toMatch(/interlaced/)
    expect(refusal(pngFromRows(1, 1, 8, 3, [Uint8Array.of(0)])), 'palette type without PLTE').toMatch(/without a palette/)
    expect(refusal(pngFromRows(1, 1, 8, 3, [Uint8Array.of(5)], [chunk('PLTE', Uint8Array.of(1, 2, 3))])), 'index past the palette').toMatch(/palette index 5/)
    expect(refusal(Buffer.concat([PNG_SIGNATURE, ihdr(1, 1, 8, 2), chunk('ZZZZ', new Uint8Array()), chunk('IEND', new Uint8Array())])), 'unknown critical chunk').toMatch(/unknown critical chunk ZZZZ/)
  })

  it('refuses a header over the pixel limit before allocating anything', () => {
    const side = Math.ceil(Math.sqrt(MAX_PNG_PIXELS)) + 1
    const bomb = Buffer.concat([PNG_SIGNATURE, ihdr(side, side, 8, 6), chunk('IDAT', deflateSync(Buffer.alloc(16))), chunk('IEND', new Uint8Array())])
    expect(refusal(bomb)).toMatch(/over the 40000000 pixel limit/)
  })

  it('stops inflating at the size the header promises (a decompression bomb) and refuses too little data', () => {
    // 2x2 RGB needs 2 * (1 + 6) = 14 bytes; 10 MB of zeros compresses to ~10 KB.
    const bomb = Buffer.concat([PNG_SIGNATURE, ihdr(2, 2, 8, 2), chunk('IDAT', deflateSync(Buffer.alloc(10_000_000))), chunk('IEND', new Uint8Array())])
    expect(refusal(bomb)).toBe('more image data than the header says')
    const short = Buffer.concat([PNG_SIGNATURE, ihdr(2, 2, 8, 2), chunk('IDAT', deflateSync(Buffer.alloc(7))), chunk('IEND', new Uint8Array())])
    expect(refusal(short)).toBe('image data is 7 bytes, the header says 14')
  })

  it('refuses an unknown row filter', () => {
    const raw = Buffer.from([7, 1, 2, 3])
    expect(refusal(Buffer.concat([PNG_SIGNATURE, ihdr(1, 1, 8, 2), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]))).toBe('unknown row filter 7 on row 0')
  })

  it('reads the pixel at a given place (orientation check: x right, y down)', () => {
    const img = canvas(4, 3, [0, 0, 0])
    img.rect(3, 2, 4, 3, [200, 100, 50])
    const out = decoded(encodePng(img))
    expect(pixel(out, 3, 2)).toEqual([200, 100, 50])
    expect(pixel(out, 0, 0)).toEqual([0, 0, 0])
  })
})
