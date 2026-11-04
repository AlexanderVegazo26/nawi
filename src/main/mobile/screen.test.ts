import { describe, expect, it } from 'vitest'
import { captureScreen, pngSize, type BinaryExec, type BinaryExecResult } from './screen'

/**
 * The live screen's frame grab (roadmap M1d) against a fake adb: the exact command, the PNG check, and one fix per
 * failure (adb missing, no answer, device gone, a screencap that printed text instead of an image).
 */

/** A minimal PNG header: signature + IHDR with the given size (enough for pngSize; not a decodable image). */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, width)
  v.setUint32(20, height)
  return b
}

function fakeAdb(reply: Partial<BinaryExecResult>): { exec: BinaryExec; calls: { file: string; args: string[]; timeoutMs: number }[] } {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = []
  const exec: BinaryExec = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs })
    return { code: 0, stdout: new Uint8Array(), stderr: '', ...reply }
  }
  return { exec, calls }
}

describe('pngSize', () => {
  it('reads width and height from the IHDR chunk', () => {
    expect(pngSize(png(1080, 2400)), 'size of a 1080x2400 PNG header').toEqual({ width: 1080, height: 2400 })
  })

  it('refuses bytes that are not a PNG, a truncated header and a zero-sized image', () => {
    expect(pngSize(new TextEncoder().encode('/system/bin/sh: screencap: not found\n')), 'text output').toBeNull()
    expect(pngSize(png(10, 10).subarray(0, 20)), 'header cut before the height').toBeNull()
    expect(pngSize(png(0, 10)), 'zero width').toBeNull()
    const wrongChunk = png(10, 10)
    wrongChunk.set([0x49, 0x44, 0x41, 0x54], 12) // IDAT first: not a valid PNG
    expect(pngSize(wrongChunk), 'first chunk is not IHDR').toBeNull()
    const wrongSignature = png(10, 10)
    wrongSignature[1] = 0x51 // "\x89QNG": IHDR in place, but not a PNG
    expect(pngSize(wrongSignature), 'bad signature with a valid IHDR').toBeNull()
  })
})

describe('captureScreen', () => {
  it('asks adb for one PNG over exec-out on the given serial and returns it with its size', async () => {
    const image = png(720, 1280)
    const adb = fakeAdb({ stdout: image })
    const frame = await captureScreen('/sdk/platform-tools/adb', 'emulator-5560', adb.exec)
    expect(adb.calls.map((c) => [c.file, ...c.args]), 'adb command line').toEqual([
      ['/sdk/platform-tools/adb', '-s', 'emulator-5560', 'exec-out', 'screencap', '-p']
    ])
    expect(frame, 'frame for a PNG reply').toEqual({ ok: true, png: image, width: 720, height: 1280 })
  })

  it('says to install the platform tools when adb cannot start', async () => {
    const frame = await captureScreen('/missing/adb', 'emulator-5560', fakeAdb({ code: null, error: 'not_found' }).exec)
    expect(frame.ok, 'frame when adb is missing').toBe(false)
    if (!frame.ok) expect(frame.fix, 'fix when adb is missing').toMatch(/Platform-Tools/)
  })

  it('names the serial to check when the device does not answer in time', async () => {
    const frame = await captureScreen('adb', 'emulator-5560', fakeAdb({ code: null, error: 'timeout' }).exec)
    expect(frame, 'frame on timeout').toMatchObject({ ok: false, error: expect.stringMatching(/emulator-5560 did not send/), fix: expect.stringMatching(/adb -s emulator-5560 shell echo ok/) })
  })

  it('says to reconnect when the device went away', async () => {
    const frame = await captureScreen('adb', 'R58M123', fakeAdb({ code: 1, error: 'failed', stderr: "adb: device 'R58M123' not found\n" }).exec)
    expect(frame, 'frame for a vanished device').toMatchObject({ ok: false, error: 'R58M123 is no longer connected', fix: expect.stringMatching(/Reconnect R58M123/) })
  })

  it('reports the text a screencap printed instead of an image, with the command to run by hand', async () => {
    const text = new TextEncoder().encode('/system/bin/sh: screencap: inaccessible or not found\n')
    const frame = await captureScreen('adb', 'emulator-5554', fakeAdb({ code: 0, stdout: text }).exec)
    expect(frame, 'frame for text output').toMatchObject({
      ok: false,
      error: expect.stringContaining('screencap: inaccessible or not found'),
      fix: expect.stringContaining('adb -s emulator-5554 exec-out screencap -p')
    })
  })

  it('reports a frame over the size limit as too large, not as a timeout', async () => {
    const frame = await captureScreen('adb', 'emulator-5554', fakeAdb({ code: null, error: 'too_large' }).exec)
    expect(frame, 'frame over the limit').toMatchObject({ ok: false, error: 'emulator-5554 sent more than 48 MB for one frame' })
  })

  it('reports an empty reply and a failing exit code without a stack trace', async () => {
    const empty = await captureScreen('adb', 'emulator-5554', fakeAdb({ code: 0 }).exec)
    expect(empty, 'frame for an empty reply').toMatchObject({ ok: false, error: 'screencap did not return an image (no image)' })
    const failed = await captureScreen('adb', 'emulator-5554', fakeAdb({ code: 1, error: 'failed' }).exec)
    expect(failed, 'frame for exit code 1').toMatchObject({ ok: false, error: 'screencap did not return an image (exit code 1)' })
  })
})
