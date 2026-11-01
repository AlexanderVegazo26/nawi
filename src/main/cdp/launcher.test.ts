import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findPlaywrightChromium } from './launcher'

/** A fake Playwright browsers root: each entry is a file path made under it. */
function makeRoot(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'nawi-pw-'))
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

describe('findPlaywrightChromium', () => {
  let root = ''
  beforeEach(() => {
    root = ''
  })
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['linux', 'x64', 'chromium-1248/chrome-linux64/chrome'],
    ['linux', 'arm64', 'chromium-1248/chrome-linux-arm64/chrome'],
    ['win32', 'x64', 'chromium-1248/chrome-win64/chrome.exe'],
    [
      'darwin',
      'arm64',
      'chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    ],
    [
      'darwin',
      'x64',
      'chromium-1248/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    ]
  ] as const)('finds the current Playwright layout on %s/%s', (platform, arch, file) => {
    root = makeRoot([file])
    const found = findPlaywrightChromium(root, platform, arch)
    expect(found, `expected ${file} under ${root} to be found`).toEqual({
      kind: 'playwright-chromium',
      path: join(root, file)
    })
  })

  it('still finds the older chrome-linux layout', () => {
    root = makeRoot(['chromium-1100/chrome-linux/chrome'])
    expect(findPlaywrightChromium(root, 'linux', 'x64')?.path).toBe(join(root, 'chromium-1100/chrome-linux/chrome'))
  })

  it('prefers the numerically newest build that has an executable', () => {
    root = makeRoot([
      'chromium-99/chrome-linux64/chrome',
      'chromium-1234/chrome-linux64/chrome',
      // Newest build directory, but the download never completed: no executable.
      'chromium-1300/INSTALLATION_COMPLETE'
    ])
    expect(findPlaywrightChromium(root, 'linux', 'x64')?.path).toBe(join(root, 'chromium-1234/chrome-linux64/chrome'))
  })

  it('ignores headless-shell builds and returns null for a missing root', () => {
    root = makeRoot(['chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell'])
    expect(findPlaywrightChromium(root, 'linux', 'x64')).toBeNull()
    expect(findPlaywrightChromium(join(root, 'does-not-exist'), 'linux', 'x64')).toBeNull()
  })
})
