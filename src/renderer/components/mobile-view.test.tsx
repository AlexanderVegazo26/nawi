// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { IpcResult } from '@shared/types'
import type { MobileOpenView, MobileProgress, MobileScreenFrame } from '@shared/mobile'
import { LiveScreen, MobileView, SCREEN_MAX_FAILURES, dragHasFiles, isAndroidPackageName, useMobileOpen, type ApkRequest, type MobileOpen } from './MobileView'

/**
 * Roadmap M1d — the window's "drop an .apk, see it running" view against a fake main: steps appear as main reports
 * them, a failure shows its one fix, Cancel and Try again reach main, and the live screen polls one frame at a time
 * and stops (with a retry) after repeated failures. Main's replies are released by the test, so every in-between
 * state is asserted rather than raced.
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const REQ: ApkRequest = { path: '/home/u/apps/demo.apk', name: 'demo.apk', nonce: 1 }

function view(over: Partial<MobileOpenView> = {}): MobileOpenView {
  return {
    openId: 1,
    ok: true,
    cancelled: false,
    fix: null,
    package: 'com.example.demo',
    target: { kind: 'avd', name: 'loop-api36', serial: 'emulator-5560', api: 36, booted: true },
    launched: { activity: 'com.example.demo.MainActivity', total_time_ms: 812, pid: 4242 },
    steps: [
      { id: 'read', status: 'ok', summary: 'com.example.demo', fix: null },
      { id: 'doctor', status: 'ok', summary: 'virtual device loop-api36 (API 36)', fix: null },
      { id: 'boot', status: 'ok', summary: 'loop-api36 booted as emulator-5560', fix: null },
      { id: 'install', status: 'ok', summary: 'installed', fix: null },
      { id: 'grant', status: 'skipped', summary: 'no runtime permissions to grant', fix: null },
      { id: 'settings', status: 'ok', summary: 'animations off, dark mode off, font scale 1, locale en-US', fix: null },
      { id: 'launch', status: 'ok', summary: 'started in 812 ms', fix: null }
    ],
    profile: '/home/u/apps/com.example.demo.nawi.mobile.yaml',
    profile_error: null,
    ...over
  }
}

let opens: { path: string; reply: Deferred<IpcResult<MobileOpenView>> }[]
let progress: Set<(p: MobileProgress) => void>
let cancels: number
let frames: { serial: string; reply: Deferred<IpcResult<MobileScreenFrame>> }[]
let urls: string[]
let revoked: string[]

beforeEach(() => {
  opens = []
  progress = new Set()
  cancels = 0
  frames = []
  urls = []
  revoked = []
  ;(window as unknown as { api: unknown }).api = {
    openApk: (path: string) => {
      const reply = deferred<IpcResult<MobileOpenView>>()
      opens.push({ path, reply })
      return reply.promise
    },
    cancelMobileOpen: async () => {
      cancels++
      return { ok: true, value: true }
    },
    onMobileProgress: (cb: (p: MobileProgress) => void) => {
      progress.add(cb)
      return () => progress.delete(cb)
    },
    getMobileScreen: (serial: string) => {
      const reply = deferred<IpcResult<MobileScreenFrame>>()
      frames.push({ serial, reply })
      return reply.promise
    }
  }
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => {
    const u = `blob:nawi/${urls.length + 1}`
    urls.push(u)
    return u
  })
  URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u))
})

afterEach(() => {
  cleanup()
})

function emit(p: Omit<MobileProgress, 'openId'>): void {
  act(() => {
    for (const cb of progress) cb({ openId: 1, ...p })
  })
}

async function reply(i: number, r: IpcResult<MobileOpenView>): Promise<void> {
  await act(async () => {
    opens[i].reply.resolve(r)
    await opens[i].reply.promise
  })
}

function stepRow(label: string): HTMLElement {
  const steps = screen.getByRole('list', { name: 'Steps' })
  const item = within(steps)
    .getAllByRole('listitem')
    .find((li) => li.querySelector('p')?.textContent?.startsWith(label))
  if (!item) throw new Error(`no step row starting with "${label}" in: ${steps.textContent}`)
  return item
}


/** Stands in for App: owns the open (useMobileOpen) and may hide the view (editor shown) without losing it. */
let hostOpen: MobileOpen
function Host({ show = true, active = true, interval = 1000, onPick = () => {} }: { show?: boolean; active?: boolean; interval?: number; onPick?: (f: File) => void }): React.JSX.Element | null {
  const open = useMobileOpen()
  hostOpen = open
  return show ? <MobileView open={open} onPick={onPick} active={active} screenIntervalMs={interval} /> : null
}

function startOpen(req: ApkRequest = REQ): boolean {
  let started = false
  act(() => {
    started = hostOpen.start(req)
  })
  return started
}

const frame = (w = 1080, h = 2400): IpcResult<MobileScreenFrame> => ({ ok: true, value: { ok: true, png: new Uint8Array([137, 80]), width: w, height: h } })

describe('MobileView', () => {
  it('without a request shows how to start and a file button', () => {
    render(<Host />)
    expect(screen.getByRole('heading', { name: 'Open an Android app' }), 'empty state heading').toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose an .apk…' }), 'file button').toBeTruthy()
    expect(opens.length, 'opens without a request').toBe(0)
  })

  it('opens the requested file and marks each step as main reports it', async () => {
    render(<Host />)
    startOpen()
    expect(opens.map((o) => o.path), 'paths sent to main').toEqual([REQ.path])
    expect(screen.getByRole('status').textContent, 'status while running').toBe('Opening the app…')
    emit({ id: 'read', summary: 'reading the app file' })
    emit({ id: 'doctor', summary: 'checking the Android setup' })
    expect(stepRow('Read the app').textContent, 'read row after doctor started').toContain('— done')
    expect(stepRow('Find a device').textContent, 'doctor row').toContain('— in progress')
    expect(stepRow('Find a device').textContent, 'doctor summary').toContain('checking the Android setup')
    expect(stepRow('Install').textContent, 'install row before it starts').toContain('— waiting')
    expect(screen.getByRole('button', { name: 'Choose an .apk…' }).hasAttribute('disabled'), 'file button disabled while running').toBe(true)
  })

  it('on success says where the app runs, shows the saved profile and the live screen', async () => {
    render(<Host interval={1} />)
    startOpen()
    await reply(0, { ok: true, value: view() })
    expect(screen.getByRole('status').textContent, 'status after success').toBe('com.example.demo is running on loop-api36.')
    expect(stepRow('Grant permissions').textContent, 'grant row').toContain('— skipped')
    expect(stepRow('Device settings').textContent, 'settings row with what was set').toContain('animations off, dark mode off, font scale 1, locale en-US')
    expect(screen.getByText(/Saved as \/home\/u\/apps\/com\.example\.demo\.nawi\.mobile\.yaml/), 'profile line').toBeTruthy()
    expect(frames.map((f) => f.serial), 'frames asked for').toEqual(['emulator-5560'])
    await act(async () => frames[0].reply.resolve(frame()))
    const img = await screen.findByRole('img', { name: 'Live screen of emulator-5560' })
    expect(img.getAttribute('src'), 'image source').toBe('blob:nawi/1')
    expect([img.getAttribute('width'), img.getAttribute('height')], 'intrinsic size').toEqual(['1080', '2400'])
    expect(screen.getByRole('button', { name: 'Open again' }), 'open again button').toBeTruthy()
  })

  it('on failure shows the one fix as an alert, marks later steps as not run, and Try again reopens', async () => {
    const user = userEvent.setup()
    render(<Host />)
    startOpen()
    emit({ id: 'read', summary: 'reading the app file' })
    emit({ id: 'doctor', summary: 'checking the Android setup' })
    const fix = 'Turn on hardware virtualization (VT-x/AMD-V) in the BIOS, then retry.'
    await reply(0, {
      ok: true,
      value: view({ ok: false, fix, target: null, launched: null, profile: null, steps: [{ id: 'read', status: 'ok', summary: 'com.example.demo', fix: null }, { id: 'doctor', status: 'fail', summary: 'virtual devices can\'t start here', fix }] })
    })
    expect(screen.getByRole('alert').textContent, 'alert text').toContain(fix)
    expect(stepRow('Find a device').textContent, 'doctor row').toContain('— failed')
    expect(stepRow('Launch').textContent, 'launch row').toContain('— not run')
    expect(frames.length, 'screen frames after a failure').toBe(0)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(opens.map((o) => o.path), 'paths sent to main').toEqual([REQ.path, REQ.path])
  })

  it('Cancel asks main to stop and the running step shows as cancelled', async () => {
    const user = userEvent.setup()
    render(<Host />)
    startOpen()
    emit({ id: 'read', summary: 'reading the app file' })
    emit({ id: 'doctor', summary: 'checking the Android setup' })
    emit({ id: 'boot', summary: 'booting loop-api36 as emulator-5560' })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancels, 'cancel calls').toBe(1)
    await reply(0, { ok: true, value: view({ ok: false, cancelled: true, steps: [], target: null, launched: null, profile: null }) })
    expect(screen.getByRole('status').textContent, 'status after cancel').toBe('Cancelled.')
    expect(stepRow('Start the virtual device').textContent, 'boot row').toContain('— cancelled')
    expect(stepRow('Find a device').textContent, 'doctor row').toContain('— done')
    expect(screen.queryByRole('alert'), 'alert after cancel').toBeNull()
  })

  it('shows main\'s refusal (an IPC error) as an alert', async () => {
    render(<Host />)
    startOpen()
    await reply(0, { ok: false, error: 'An app is already being opened: wait for it to finish or press Cancel.' })
    expect(screen.getByRole('alert').textContent, 'alert text').toContain('already being opened')
  })

  it('ignores progress that arrives while nothing is opening', () => {
    render(<Host />)
    emit({ id: 'install', summary: 'stale event from an earlier window' })
    expect(screen.queryByRole('list', { name: 'Steps' }), 'step list').toBeNull()
  })

  it('keeps the open and its progress when the view is unmounted and shown again, without opening twice', async () => {
    const { rerender } = render(<Host />)
    startOpen()
    emit({ id: 'read', summary: 'reading the app file' })
    rerender(<Host show={false} />)
    emit({ id: 'doctor', summary: 'checking the Android setup' })
    rerender(<Host />)
    expect(opens.length, 'opens after the view came back').toBe(1)
    expect(stepRow('Find a device').textContent, 'doctor row after the view came back').toContain('— in progress')
    await reply(0, { ok: true, value: view() })
    expect(screen.getByRole('status').textContent, 'status after success').toBe('com.example.demo is running on loop-api36.')
  })

  it('refuses a second start while one runs, keeping the first file', async () => {
    render(<Host />)
    expect(startOpen(), 'first start').toBe(true)
    expect(startOpen({ path: '/home/u/apps/other.apk', name: 'other.apk', nonce: 2 }), 'second start while running').toBe(false)
    expect(opens.map((o) => o.path), 'paths sent to main').toEqual([REQ.path])
    expect(screen.getByRole('heading', { name: 'demo.apk' }), 'heading still names the first file').toBeTruthy()
    await reply(0, { ok: true, value: view() })
    expect(startOpen({ path: '/home/u/apps/other.apk', name: 'other.apk', nonce: 2 }), 'start after it finished').toBe(true)
  })

  it('ignores progress tagged with another open id', () => {
    render(<Host />)
    startOpen()
    emit({ id: 'read', summary: 'reading the app file' })
    act(() => {
      for (const cb of progress) cb({ openId: 7, id: 'install', summary: 'from an earlier open' })
    })
    expect(stepRow('Install').textContent, 'install row').toContain('— waiting')
  })

  it('stops the live screen while another view is shown', async () => {
    const { rerender } = render(<Host interval={1} />)
    startOpen()
    await reply(0, { ok: true, value: view() })
    expect(frames.length, 'frames while active').toBe(1)
    rerender(<Host interval={1} active={false} />)
    expect(screen.queryByRole('region', { name: 'Screen of emulator-5560' }), 'screen region while inactive').toBeNull()
  })

  it('hands a picked file to onPick', async () => {
    const user = userEvent.setup()
    const picked: File[] = []
    const { container } = render(<Host onPick={(f) => picked.push(f)} />)
    const input = container.querySelector('input[type=file]') as HTMLInputElement
    expect(input.getAttribute('accept'), 'accepted types').toBe('.apk,.aab')
    const file = new File([new Uint8Array([80, 75])], 'demo.apk')
    await user.upload(input, file)
    expect(picked.map((f) => f.name), 'picked files').toEqual(['demo.apk'])
  })
})

describe('LiveScreen', () => {
  it('asks for the next frame only after the last reply, and frees the old image', async () => {
    render(<LiveScreen serial="emulator-5560" intervalMs={1} />)
    expect(frames.length, 'frames before the first reply').toBe(1)
    await act(async () => frames[0].reply.resolve(frame()))
    await waitFor(() => expect(frames.length, 'frames after the first reply').toBe(2))
    await act(async () => frames[1].reply.resolve(frame()))
    await waitFor(() => expect(revoked, 'revoked urls').toEqual(['blob:nawi/1']))
  })

  it(`shows the fix, then stops after ${SCREEN_MAX_FAILURES} failed frames until the user asks again`, async () => {
    const user = userEvent.setup()
    render(<LiveScreen serial="emulator-5560" intervalMs={1} />)
    const bad: IpcResult<MobileScreenFrame> = { ok: true, value: { ok: false, error: 'emulator-5560 is no longer connected', fix: 'Reconnect emulator-5560 (or restart that emulator), then open the app again.' } }
    for (let i = 0; i < SCREEN_MAX_FAILURES; i++) {
      await waitFor(() => expect(frames.length, `frame request ${i + 1}`).toBe(i + 1))
      await act(async () => frames[i].reply.resolve(bad))
    }
    const alert = await screen.findByRole('alert')
    expect(alert.textContent, 'alert text').toContain('Reconnect emulator-5560')
    // No further request once stopped.
    await new Promise((r) => setTimeout(r, 20))
    expect(frames.length, 'requests after stopping').toBe(SCREEN_MAX_FAILURES)
    await user.click(screen.getByRole('button', { name: 'Show the screen again' }))
    await waitFor(() => expect(frames.length, 'requests after retry').toBe(SCREEN_MAX_FAILURES + 1))
  })

  it('treats an IPC error like a failed frame (no fix line)', async () => {
    render(<LiveScreen serial="emulator-5560" intervalMs={1} />)
    await act(async () => frames[0].reply.resolve({ ok: false, error: 'No app was opened on that device from this window.' }))
    expect(await screen.findByText('No app was opened on that device from this window.'), 'error text').toBeTruthy()
  })
})

describe('drop helpers', () => {
  it('accepts .apk and .aab names in any case, nothing else', () => {
    expect(['a.apk', 'B.APK', 'c.aab', 'x.apk.zip', 'apk', 'notes.txt'].map(isAndroidPackageName), 'names').toEqual([true, true, true, false, false, false])
  })

  it('treats only a drag that carries files as a file drop', () => {
    const dt = (types: string[]) => ({ types }) as unknown as DataTransfer
    expect([dragHasFiles(dt(['Files'])), dragHasFiles(dt(['text/plain', 'text/uri-list'])), dragHasFiles(null)], 'drags').toEqual([true, false, false])
  })
})
