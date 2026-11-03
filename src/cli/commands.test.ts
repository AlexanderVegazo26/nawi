import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMANDS, FollowUsageError, commandTools, newRuns, parseFollow, renderTools, toolDescriptors } from './commands'

/** Tool names as declared in the MCP tool table. tools.ts imports electron, so read its source instead. */
function declaredTools(): string[] {
  const src = readFileSync(resolve(__dirname, '../main/mcp/tools.ts'), 'utf8')
  return [...src.matchAll(/defineTool\(\{\s*name:\s*'([a-z_]+)'/g)].map((m) => m[1])
}

describe('CLI / MCP parity (roadmap AI11)', () => {
  it('finds the tools in tools.ts (guards the parser used below)', () => {
    expect(declaredTools().length, `declared tools: ${declaredTools().join(', ')}`).toBeGreaterThanOrEqual(16)
  })

  it('has exactly one CLI command per MCP tool, and no command for a tool that does not exist', () => {
    const declared = declaredTools().sort()
    const commands = commandTools().sort()
    expect(commands, 'tools with a CLI command (left) vs tools declared in src/main/mcp/tools.ts (right)').toEqual(declared)
  })

  it('names no command twice', () => {
    const tools = commandTools()
    expect(new Set(tools).size, `duplicate tools in COMMANDS: ${tools.join(', ')}`).toBe(tools.length)
  })

  it('does not shadow the built-in commands', () => {
    for (const reserved of ['tools', 'help', 'serve']) {
      expect(Object.keys(COMMANDS), `COMMANDS must not define "${reserved}"`).not.toContain(reserved)
    }
  })
})

describe('toolDescriptors / renderTools', () => {
  it('rejects a result that is not a tools/list answer', () => {
    expect(() => toolDescriptors({ content: [] })).toThrow(/unexpected tools\/list/)
    expect(() => toolDescriptors(null)).toThrow(/unexpected tools\/list/)
  })

  it('tolerates a tool entry without a description and drops one without a name', () => {
    const tools = toolDescriptors({ tools: [{ name: 'a' }, { description: 'x' }, null] })
    expect(tools).toEqual([{ name: 'a', description: '' }])
    expect(renderTools(tools)).toMatch(/^a\s+-\s*$/)
  })

  it('prints name, CLI command and first sentence, "-" when a tool has no command', () => {
    const out = renderTools([
      { name: 'list_runs', description: 'List saved runs. More detail here.', inputSchema: {} },
      { name: 'future_tool', description: 'Does a thing', inputSchema: {} }
    ])
    const [a, b] = out.split('\n')
    expect(a).toMatch(/^list_runs\s+runs\s+List saved runs\.$/)
    expect(b).toMatch(/^future_tool\s+-\s+Does a thing$/)
  })
})

describe('newRuns', () => {
  const r = (id: string) => ({ run_id: id, status: 'passed' })

  it('returns unseen runs oldest first and remembers them', () => {
    const seen = new Set<string>(['c'])
    expect(newRuns(seen, [r('e'), r('d'), r('c'), r('b')]).map((x) => x.run_id)).toEqual(['b', 'd', 'e'])
    expect(newRuns(seen, [r('e'), r('d'), r('c'), r('b')])).toEqual([])
  })

  it('skips entries without a string run_id', () => {
    expect(newRuns(new Set(), [{ run_id: 3 } as never, null as never, r('a')]).map((x) => x.run_id)).toEqual(['a'])
  })
})

describe('parseFollow', () => {
  it('is null without --follow', () => {
    expect(parseFollow({ limit: 5 })).toBeNull()
  })

  it('defaults to 1 s and passes every other flag to list_runs', () => {
    expect(parseFollow({ follow: true, status: 'failed' })).toEqual({ interval: 1000, filter: { status: 'failed', limit: 200 } })
  })

  it('accepts an --interval in range', () => {
    expect(parseFollow({ follow: true, interval: 250 })?.interval).toBe(250)
  })

  it.each([['fast', 'fast'], ['too small', 10], ['fractional', 500.5], ['too large', 4_000_000]])(
    'rejects an %s --interval',
    (_label, interval) => {
      expect(() => parseFollow({ follow: true, interval })).toThrow(FollowUsageError)
    }
  )

  it('rejects --limit with --follow (a small window would drop runs) and --interval without it', () => {
    expect(() => parseFollow({ follow: true, limit: 1 })).toThrow(/--limit cannot be combined/)
    expect(() => parseFollow({ interval: 500 })).toThrow(/only applies together with --follow/)
  })

  it('rejects a value given to --follow', () => {
    expect(() => parseFollow({ follow: 'yes' })).toThrow(/takes no value/)
  })
})
