import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { isLoopbackUrl, readEndpoint } from './endpoint'

/**
 * mcp.json is the only thing telling the bridge and the CLI where to send the
 * agent's traffic and the bearer token, so a rewritten file must not be able to
 * aim them anywhere but this machine (docs/SECURITY-REVIEW-M1A.md).
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nawi-endpoint-'))
  vi.stubEnv('NAWI_MCP_CONFIG', join(dir, 'mcp.json'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function writeConfig(url: unknown): void {
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ url, token: 'tok-123', pid: 42 }))
}

describe('readEndpoint', () => {
  test('returns the endpoint the app publishes (http://127.0.0.1:<port>/mcp)', () => {
    writeConfig('http://127.0.0.1:43123/mcp')
    expect(readEndpoint(), 'the app-written mcp.json').toEqual({
      url: 'http://127.0.0.1:43123/mcp',
      token: 'tok-123',
      pid: 42
    })
  })

  test.each([
    'http://evil.example:43123/mcp',
    'http://127.0.0.1@evil.example/mcp',
    'http://127.0.0.1.evil.example/mcp',
    'https://127.0.0.1:43123/mcp',
    'http://10.0.0.5:43123/mcp',
    'http://user:pass@127.0.0.1:43123/mcp',
    'not a url'
  ])('refuses a non-loopback url in mcp.json as if the app were not running: %s', (url) => {
    writeConfig(url)
    expect(readEndpoint(), `mcp.json url ${JSON.stringify(url)} must not be trusted`).toBeNull()
  })

  test('returns null when mcp.json is missing', () => {
    expect(readEndpoint(), 'no mcp.json under NAWI_MCP_CONFIG').toBeNull()
  })
})

describe('isLoopbackUrl', () => {
  test.each(['http://127.0.0.1:1/mcp', 'http://localhost:1/mcp', 'http://[::1]:1/mcp'])(
    'accepts loopback host %s',
    (url) => {
      expect(isLoopbackUrl(url), `${url} is loopback`).toBe(true)
    }
  )

  test.each(['http://[::2]:1/mcp', 'http://localhost.evil.example/mcp', 'file:///etc/passwd', ''])(
    'rejects %s',
    (url) => {
      expect(isLoopbackUrl(url), `${JSON.stringify(url)} is not a loopback http URL`).toBe(false)
    }
  )
})
