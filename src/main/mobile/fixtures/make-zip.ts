import { deflateRawSync } from 'node:zlib'

/** A minimal zip writer for hostile and odd archives the real toolchain would never produce. */
export interface FakeEntry {
  name: string
  data?: Uint8Array
  deflate?: boolean
  flags?: number
  /** Overrides the uncompressed size written to the central directory. */
  declaredSize?: number
}
export function makeZip(entries: FakeEntry[]): Uint8Array {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? new Uint8Array())
    const body = e.deflate ? deflateRawSync(raw) : raw
    const name = Buffer.from(e.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(e.flags ?? 0, 6)
    local.writeUInt16LE(e.deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(e.flags ?? 0, 8)
    cd.writeUInt16LE(e.deflate ? 8 : 0, 10)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(e.declaredSize ?? raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    central.push(cd, name)
    offset += local.length + name.length + body.length
  }
  const cdBytes = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBytes.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, cdBytes, eocd]))
}
