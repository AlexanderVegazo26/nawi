import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { removeIfOwned } = await import('./server')

/** Shutdown removes the endpoint file only while it still names this process (`nawi serve` next to the app). */
describe('removeIfOwned', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'nawi-mcp-close-'))
    file = join(dir, 'mcp.json')
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('removes the file that names our pid', async () => {
    await fs.writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: 't', pid: 100 }))
    expect(await removeIfOwned(file, 100), 'own file').toBe(true)
    await expect(fs.access(file), `${file} should be gone`).rejects.toThrow()
  })

  it("leaves another instance's file in place", async () => {
    await fs.writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: 't', pid: 200 }))
    expect(await removeIfOwned(file, 100), 'pid 200 published since').toBe(false)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).pid, 'file untouched').toBe(200)
  })

  it('does nothing for a missing or unreadable file', async () => {
    expect(await removeIfOwned(file, 100), 'missing').toBe(false)
    await fs.writeFile(file, '{not json')
    expect(await removeIfOwned(file, 100), 'garbage').toBe(false)
  })
})
