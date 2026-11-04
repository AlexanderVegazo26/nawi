import { corrupt } from './errors'

/**
 * A reader for Android's binary XML (the compiled AndroidManifest.xml inside an APK). The format is a tree of chunks:
 * a string pool, an optional resource map (attribute name index -> android:attr resource id), then start/end element
 * events. Only what a manifest needs is decoded; unknown chunks are skipped. The input is untrusted, so every read is
 * bounds-checked and the element count and depth are capped.
 */

export type AxmlValue = string | number | boolean | null

export interface AxmlAttribute {
  /** Namespace URI, or '' for none (e.g. `package` on <manifest>). */
  ns: string
  name: string
  /** The android:attr resource id from the resource map, when the build recorded one. */
  resId: number | null
  value: AxmlValue
}

export interface AxmlElement {
  name: string
  attributes: AxmlAttribute[]
  children: AxmlElement[]
}

const RES_XML = 0x0003
const RES_STRING_POOL = 0x0001
const RES_XML_RESOURCE_MAP = 0x0180
const RES_XML_START_ELEMENT = 0x0102
const RES_XML_END_ELEMENT = 0x0103
const UTF8_FLAG = 0x100
const NO_INDEX = 0xffffffff
const UTF8 = new TextDecoder('utf-8')
const UTF16 = new TextDecoder('utf-16le')

export const MAX_ELEMENTS = 100_000
export const MAX_DEPTH = 64

// Typed value types (ResourceTypes.h Res_value::dataType).
const TYPE_NULL = 0x00
const TYPE_REFERENCE = 0x01
const TYPE_STRING = 0x03
const TYPE_INT_DEC = 0x10
const TYPE_INT_HEX = 0x11
const TYPE_INT_BOOLEAN = 0x12

class Reader {
  readonly v: DataView
  constructor(readonly bytes: Uint8Array) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  private check(at: number, n: number): void {
    if (at < 0 || at + n > this.bytes.length) throw corrupt('the manifest is cut short or has a bad offset')
  }
  u8(at: number): number {
    this.check(at, 1)
    return this.v.getUint8(at)
  }
  u16(at: number): number {
    this.check(at, 2)
    return this.v.getUint16(at, true)
  }
  u32(at: number): number {
    this.check(at, 4)
    return this.v.getUint32(at, true)
  }
  slice(at: number, n: number): Uint8Array {
    this.check(at, n)
    return this.bytes.subarray(at, at + n)
  }
}

/** Strings are decoded on demand: a manifest references a fraction of its pool. */
class StringPool {
  private readonly cache = new Map<number, string>()
  private readonly utf8: boolean
  private readonly count: number
  private readonly offsets: number
  private readonly data: number

  constructor(private readonly r: Reader, start: number, headerSize: number, private readonly end: number) {
    this.count = r.u32(start + 8)
    this.utf8 = (r.u32(start + 16) & UTF8_FLAG) !== 0
    this.offsets = start + headerSize
    this.data = start + r.u32(start + 20)
    if (this.offsets + this.count * 4 > end || this.data > end) throw corrupt('the manifest string pool is damaged')
  }

  get(index: number): string {
    if (index === NO_INDEX) return ''
    if (index >= this.count) throw corrupt(`the manifest refers to string ${index} of ${this.count}`)
    const hit = this.cache.get(index)
    if (hit !== undefined) return hit
    const at = this.data + this.r.u32(this.offsets + index * 4)
    const s = this.utf8 ? this.utf8At(at) : this.utf16At(at)
    this.cache.set(index, s)
    return s
  }

  private utf8At(at: number): string {
    // Two lengths, each 1 or 2 bytes: UTF-16 units (unused here), then UTF-8 bytes.
    let p = at + (this.r.u8(at) & 0x80 ? 2 : 1)
    let len = this.r.u8(p)
    if (len & 0x80) len = ((len & 0x7f) << 8) | this.r.u8(p + 1)
    p += this.r.u8(p) & 0x80 ? 2 : 1
    if (p + len > this.end) throw corrupt('a manifest string runs past its pool')
    return UTF8.decode(this.r.slice(p, len))
  }

  private utf16At(at: number): string {
    let len = this.r.u16(at)
    let p = at + 2
    if (len & 0x8000) {
      len = ((len & 0x7fff) << 16) | this.r.u16(at + 2)
      p += 2
    }
    if (p + len * 2 > this.end) throw corrupt('a manifest string runs past its pool')
    return UTF16.decode(this.r.slice(p, len * 2))
  }
}

function typedValue(type: number, data: number, raw: string | null, pool: StringPool): AxmlValue {
  switch (type) {
    case TYPE_STRING:
      return pool.get(data)
    case TYPE_INT_DEC:
      return data | 0
    case TYPE_INT_HEX:
      return data >>> 0
    case TYPE_INT_BOOLEAN:
      return data !== 0
    case TYPE_REFERENCE:
      // A resource reference (@string/host): resources.arsc is not read, so callers see it as unresolved (isReference).
      return `@0x${(data >>> 0).toString(16).padStart(8, '0')}`
    case TYPE_NULL:
      return raw
    default:
      // Dimensions, colours, floats: a manifest field Nawi reads is never one, so keep the raw text if there is one.
      return raw ?? data >>> 0
  }
}

/** Parses a binary XML document into its root element. Throws ApkError ('invalid') on any malformed input. */
export function parseAxml(bytes: Uint8Array): AxmlElement {
  const r = new Reader(bytes)
  if (bytes.length < 8 || r.u16(0) !== RES_XML) throw corrupt('AndroidManifest.xml is not compiled Android XML')
  const docEnd = Math.min(r.u32(4), bytes.length)
  let pool: StringPool | null = null
  let resMap: number[] = []
  const stack: AxmlElement[] = []
  let root: AxmlElement | null = null
  let elements = 0

  for (let at = r.u16(2); at + 8 <= docEnd; ) {
    const type = r.u16(at)
    const headerSize = r.u16(at + 2)
    const size = r.u32(at + 4)
    if (size < 8 || headerSize > size || at + size > docEnd) throw corrupt('a manifest chunk has a bad size')
    const end = at + size
    if (type === RES_STRING_POOL) {
      pool = new StringPool(r, at, headerSize, end)
    } else if (type === RES_XML_RESOURCE_MAP) {
      resMap = []
      for (let p = at + headerSize; p + 4 <= end; p += 4) resMap.push(r.u32(p))
    } else if (type === RES_XML_START_ELEMENT) {
      if (!pool) throw corrupt('the manifest has elements before its string pool')
      if (++elements > MAX_ELEMENTS) throw corrupt(`the manifest has over ${MAX_ELEMENTS} elements`)
      if (stack.length >= MAX_DEPTH) throw corrupt(`the manifest nests deeper than ${MAX_DEPTH} levels`)
      const ext = at + headerSize
      const attrStart = r.u16(ext + 8)
      const attrSize = r.u16(ext + 10)
      const attrCount = r.u16(ext + 12)
      if (attrSize < 20) throw corrupt('a manifest element has a bad attribute size')
      const el: AxmlElement = { name: pool.get(r.u32(ext + 4)), attributes: [], children: [] }
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize
        if (a + 20 > end) throw corrupt('a manifest attribute runs past its element')
        const nameIdx = r.u32(a + 4)
        const rawIdx = r.u32(a + 8)
        const raw = rawIdx === NO_INDEX ? null : pool.get(rawIdx)
        el.attributes.push({
          ns: pool.get(r.u32(a)),
          name: pool.get(nameIdx),
          resId: nameIdx < resMap.length ? resMap[nameIdx] : null,
          value: typedValue(r.u8(a + 15), r.u32(a + 16), raw, pool)
        })
      }
      if (stack.length > 0) stack[stack.length - 1].children.push(el)
      else if (root) throw corrupt('the manifest has more than one root element')
      else root = el
      stack.push(el)
    } else if (type === RES_XML_END_ELEMENT) {
      if (stack.length === 0) throw corrupt('the manifest closes an element it never opened')
      stack.pop()
    }
    at = end
  }
  if (!root) throw corrupt('AndroidManifest.xml has no elements')
  return root
}

/**
 * The android:attr resource ids of the manifest attributes Nawi reads. Release builds often strip attribute names
 * from the string pool (shrinkers do), leaving only these ids, so lookups go by id first and by name second.
 * Values verified against `aapt2 dump xmltree` (build-tools 36).
 */
export const ANDROID_ATTR = {
  name: 0x01010003,
  debuggable: 0x0101000f,
  exported: 0x01010010,
  enabled: 0x0101000e,
  scheme: 0x01010027,
  host: 0x01010028,
  port: 0x01010029,
  path: 0x0101002a,
  pathPrefix: 0x0101002b,
  pathPattern: 0x0101002c,
  minSdkVersion: 0x0101020c,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  targetSdkVersion: 0x01010270,
  maxSdkVersion: 0x01010271,
  autoVerify: 0x010104ee
} as const

/** Whether a value is an unresolved resource reference as typedValue writes it. */
export const isReference = (v: AxmlValue | undefined): v is string => typeof v === 'string' && /^@0x[0-9a-f]{8}$/.test(v)

export type AndroidAttr = keyof typeof ANDROID_ATTR

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android'

/** An android: attribute's value, matched by resource id, else by name in the android namespace. */
export function androidAttr(el: AxmlElement, name: AndroidAttr): AxmlValue | undefined {
  const id = ANDROID_ATTR[name]
  const byId = el.attributes.find((a) => a.resId === id)
  if (byId) return byId.value
  return el.attributes.find((a) => a.name === name && (a.ns === ANDROID_NS || a.ns === ''))?.value
}

/** A plain (no-namespace) attribute such as <manifest package>. */
export function plainAttr(el: AxmlElement, name: string): AxmlValue | undefined {
  return el.attributes.find((a) => a.ns === '' && a.name === name)?.value
}
