import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  ServeUsageError,
  findApp,
  parseServeArgs,
  serveCommand,
  serveEnv,
  serveExitCode
} from './serve'
import { SERVE_FLAG, isServeMode, serveReadyLine } from '../main/headless'

describe('parseServeArgs', () => {
  it('takes no options as the default profile', () => {
    expect(parseServeArgs([], '/w'), 'no args').toEqual({})
  })

  it('resolves --user-data-dir against the cwd, in both spellings', () => {
    expect(parseServeArgs(['--user-data-dir', 'prof'], '/w').userDataDir, 'spaced form').toBe(join('/w', 'prof'))
    expect(parseServeArgs(['--user-data-dir=/abs/p'], '/w').userDataDir, '= form').toBe('/abs/p')
  })

  it('stops at --help / -h, whatever follows', () => {
    expect(parseServeArgs(['--help'], '/w'), '--help').toEqual({ help: true })
    expect(parseServeArgs(['-h', '--bogus'], '/w'), '-h first').toEqual({ help: true })
  })

  it.each([
    [['--headless'], /Unknown option "--headless"/],
    [['--user-data-dir'], /needs a directory/],
    [['--user-data-dir='], /needs a directory/],
    [['--user-data-dir', '--json'], /needs a directory/],
    [['--user-data-dir', 'a', '--user-data-dir', 'b'], /given twice/],
    [['extra'], /Unknown option "extra"/]
  ])('rejects %j as a usage error', (argv, message) => {
    expect(() => parseServeArgs(argv, '/w'), `argv ${JSON.stringify(argv)}`).toThrow(ServeUsageError)
    expect(() => parseServeArgs(argv, '/w'), `argv ${JSON.stringify(argv)}`).toThrow(message)
  })
})

describe('findApp', () => {
  const only = (...paths: string[]) => (p: string) => paths.includes(p)

  it('finds the packaged Linux executable next to resources/', () => {
    const cli = '/opt/Nawi/resources/app.asar.unpacked/out/cli/index.js'
    expect(findApp(cli, 'linux', only('/opt/Nawi/nawi')), 'packaged linux').toEqual({ command: '/opt/Nawi/nawi', args: [] })
  })

  it('finds the packaged macOS executable in Contents/MacOS', () => {
    const cli = '/Applications/Nawi.app/Contents/Resources/app.asar.unpacked/out/cli/index.js'
    const exe = '/Applications/Nawi.app/Contents/MacOS/Nawi'
    expect(findApp(cli, 'darwin', only(exe)), 'packaged mac').toEqual({ command: exe, args: [] })
  })

  it('finds the packaged Windows executable', () => {
    const cli = join('C:', 'Nawi', 'resources', 'app.asar.unpacked', 'out', 'cli', 'index.js')
    const exe = join('C:', 'Nawi', 'Nawi.exe')
    expect(findApp(cli, 'win32', only(exe)), 'packaged windows').toEqual({ command: exe, args: [] })
  })

  it('runs a checkout with its own Electron and the repo as the app', () => {
    const exe = '/repo/node_modules/electron/dist/electron'
    expect(findApp('/repo/out/cli/index.js', 'linux', only(exe)), 'checkout').toEqual({ command: exe, args: ['/repo'] })
  })

  it('returns null when no app exists', () => {
    expect(findApp('/repo/out/cli/index.js', 'linux', () => false), 'nothing on disk').toBeNull()
  })
})

describe('serveCommand', () => {
  const app = { command: '/e', args: ['/repo'] }

  it('ends with the serve flag the app checks for', () => {
    const cmd = serveCommand(app, {}, 'linux', { DISPLAY: ':0' })
    expect(cmd, 'linux with a display').toEqual({ command: '/e', args: ['/repo', '--serve'] })
    expect(cmd.args.at(-1), 'CLI passes the flag the app checks').toBe(SERVE_FLAG)
  })

  it('uses the headless backend on Linux only when there is no display at all', () => {
    expect(serveCommand(app, {}, 'linux', {}).args.slice(0, 2), 'no display').toEqual(['--ozone-platform=headless', '--disable-gpu'])
    expect(serveCommand(app, {}, 'linux', { WAYLAND_DISPLAY: 'wayland-0' }).args, 'wayland').not.toContain('--ozone-platform=headless')
    expect(serveCommand(app, {}, 'darwin', {}).args, 'mac has no DISPLAY').not.toContain('--ozone-platform=headless')
  })

  it('passes the profile to Chromium', () => {
    expect(serveCommand(app, { userDataDir: '/p' }, 'win32', {}).args, 'profile').toEqual(['--user-data-dir=/p', '/repo', '--serve'])
  })
})

describe('serveEnv', () => {
  it('drops ELECTRON_RUN_AS_NODE and keeps everything else', () => {
    expect(serveEnv({ ELECTRON_RUN_AS_NODE: '1', HOME: '/h' }), 'env').toEqual({ HOME: '/h' })
  })
})

describe('serveExitCode', () => {
  it("passes the app's own code through", () => {
    expect(serveExitCode(0, null, true), 'clean stop').toBe(0)
    expect(serveExitCode(3, null, false), 'no endpoint').toBe(3)
  })

  it('is 0 when the signal we forwarded ended the app, 1 for any other signal', () => {
    expect(serveExitCode(null, 'SIGTERM', true), 'forwarded SIGTERM').toBe(0)
    expect(serveExitCode(null, 'SIGTERM', false), 'SIGTERM from elsewhere').toBe(1)
    expect(serveExitCode(null, 'SIGHUP', true), 'forwarded SIGHUP (terminal closed)').toBe(0)
    expect(serveExitCode(null, 'SIGKILL', true), 'SIGKILL').toBe(1)
  })
})

describe('serve mode (app side)', () => {
  it('is on only with the --serve switch', () => {
    expect(isServeMode(['/e', '/repo', '--serve']), 'with flag').toBe(true)
    expect(isServeMode(['/e', '/repo', '--headless']), "nawi run's flag is not serve mode").toBe(false)
  })

  it('prints the endpoint and pid but never the token', () => {
    const line = serveReadyLine({ url: 'http://127.0.0.1:5/mcp', pid: 7, token: 'SECRET' } as { url: string; pid: number })
    expect(line, 'ready line').toContain('http://127.0.0.1:5/mcp')
    expect(line, 'ready line').toContain('pid 7')
    expect(line, 'ready line must not leak the bearer token').not.toContain('SECRET')
  })
})
