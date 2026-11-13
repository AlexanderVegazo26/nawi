import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAppPage } from './navigation'

const rendererDir = join(process.cwd(), 'out', 'renderer')
const page = (name: string): string => pathToFileURL(join(rendererDir, name)).href

describe('isAppPage — what a window may navigate to', () => {
  it('allows the app’s own pages, with a query or fragment', () => {
    expect(isAppPage(page('index.html'), rendererDir)).toBe(true)
    expect(isAppPage(`${page('overlay.html')}?display=2`, rendererDir)).toBe(true)
    expect(isAppPage(`${page('hud.html')}#x`, rendererDir)).toBe(true)
  })

  it('refuses any other file, including one dropped on a window', () => {
    expect(isAppPage(pathToFileURL(join(process.cwd(), 'Downloads', 'evil.html')).href, rendererDir)).toBe(false)
    expect(isAppPage(page('other.html'), rendererDir)).toBe(false)
    expect(isAppPage(pathToFileURL(join(rendererDir, '..', 'index.html')).href, rendererDir)).toBe(false)
    expect(isAppPage('file:///etc/passwd', rendererDir)).toBe(false)
  })

  it('allows the dev server by origin only', () => {
    const dev = 'http://localhost:5173'
    expect(isAppPage('http://localhost:5173/index.html', rendererDir, dev)).toBe(true)
    expect(isAppPage('http://localhost:51730/index.html', rendererDir, dev)).toBe(false)
    expect(isAppPage('https://example.com/', rendererDir, dev)).toBe(false)
    expect(isAppPage('http://localhost:5173/index.html', rendererDir)).toBe(false)
  })

  it('refuses what is not a URL', () => {
    expect(isAppPage('not a url', rendererDir)).toBe(false)
  })
})
