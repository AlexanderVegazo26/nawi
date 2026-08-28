import { describe, expect, it } from 'vitest'
import { RingBuffer } from './ring'

describe('RingBuffer — FR-STA.3 preamble window', () => {
  it('keeps only the trailing window while the window is open', () => {
    const ring = new RingBuffer<string>({ windowMs: 30_000, maxEntries: 1000 })
    ring.push(0, 'ancient')
    ring.push(1_000, 'old')
    ring.push(35_000, 'recent')
    expect(ring.values()).toEqual(['recent'])
    expect(ring.dropped).toBe(2)
  })

  it('keeps an entry exactly at the window edge', () => {
    const ring = new RingBuffer<string>({ windowMs: 30_000, maxEntries: 1000 })
    ring.push(0, 'edge')
    ring.push(30_000, 'now')
    expect(ring.values()).toEqual(['edge', 'now'])
  })

  it('stops evicting by age once the recording starts', () => {
    const ring = new RingBuffer<string>({ windowMs: 30_000, maxEntries: 1000 })
    ring.push(0, 'preamble')
    ring.closeWindow()
    // Ten minutes later the preamble entry must still be there: FR-STA.3 wants
    // the whole recording, not a rolling 30 s of it.
    ring.push(600_000, 'during')
    expect(ring.values()).toEqual(['preamble', 'during'])
    expect(ring.dropped).toBe(0)
  })

  it('enforces the count cap even with the window closed', () => {
    const ring = new RingBuffer<number>({ windowMs: 30_000, maxEntries: 3 })
    ring.closeWindow()
    for (let i = 0; i < 10; i++) ring.push(i, i)
    // A page in a console.log loop must not exhaust memory just because the
    // recording started.
    expect(ring.values()).toEqual([7, 8, 9])
    expect(ring.dropped).toBe(7)
    expect(ring.size).toBe(3)
  })

  it('reports drops rather than losing them silently', () => {
    const ring = new RingBuffer<number>({ windowMs: 10, maxEntries: 100 })
    ring.push(0, 1)
    ring.push(100, 2)
    expect(ring.dropped).toBe(1)
  })

  it('starts empty', () => {
    const ring = new RingBuffer<number>({ windowMs: 10, maxEntries: 10 })
    expect(ring.values()).toEqual([])
    expect(ring.size).toBe(0)
    expect(ring.dropped).toBe(0)
  })
})
