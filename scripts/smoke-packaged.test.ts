import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executableCandidates, launchArgs, unpackedDir } from './smoke-packaged.ts'

describe('unpackedDir', () => {
  it.each([
    ['darwin', 'arm64', 'mac-arm64'],
    ['darwin', 'x64', 'mac'],
    ['win32', 'x64', 'win-unpacked'],
    ['win32', 'arm64', 'win-arm64-unpacked'],
    ['linux', 'x64', 'linux-unpacked'],
    ['linux', 'arm64', 'linux-arm64-unpacked']
  ] as const)('%s %s -> %s (electron-builder\'s output directory)', (platform, arch, dir) => {
    expect(unpackedDir(platform, arch)).toBe(dir)
  })
})

describe('executableCandidates', () => {
  it('points inside the .app bundle on macOS', () => {
    expect(executableCandidates('darwin', 'release/mac-arm64')).toEqual([path.join('release/mac-arm64', 'Nawi.app', 'Contents', 'MacOS', 'Nawi')])
  })
  it('uses Nawi.exe on Windows and the lower-case package name first on Linux', () => {
    expect(executableCandidates('win32', 'r')).toEqual([path.join('r', 'Nawi.exe')])
    expect(executableCandidates('linux', 'r')[0]).toBe(path.join('r', 'nawi'))
  })
})

describe('launchArgs', () => {
  it('starts the headless engine against a throwaway profile', () => {
    expect(launchArgs('darwin', '/p')).toEqual(['--serve', '--user-data-dir', '/p'])
  })
  it('adds --no-sandbox on Linux only, where an unpacked chrome-sandbox is not setuid', () => {
    expect(launchArgs('linux', '/p')[0]).toBe('--no-sandbox')
    expect(launchArgs('win32', '/p')).not.toContain('--no-sandbox')
  })
})

describe('scripts/smoke-packaged.ts command', () => {
  const script = path.resolve(import.meta.dirname, 'smoke-packaged.ts')
  const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })

  it('exits 2 and names what release/ holds when there is no build to smoke, instead of passing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nawi-smoke-test-'))
    try {
      const r = run(dir)
      expect(r.status, r.stdout + r.stderr).toBe(2)
      expect(r.stderr).toContain('no release/ directory')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an unknown architecture with exit 2 and the usage', () => {
    const r = run(import.meta.dirname, '--arch', 'mips')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage: node scripts/smoke-packaged.ts')
  })
})
