import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { postJson } from '../../mcp/post'

/** A flow file that doesn't exist, inside the home folder run_flow reads from (nothing is created there). */
const MISSING_FLOW = join(homedir(), `nawi-contract-${process.pid}-does-not-exist.nawi.yaml`)

/**
 * Roadmap AI12, "every tool has a schema, a documented error shape and a
 * contract test": one table-driven pass over the real TOOLS list, so a new tool
 * is covered the moment it is added.
 *
 * - its input schema is a JSON Schema object an MCP client can use;
 * - the codes it declares (`errors`) are exactly the ones its body can raise
 *   (checked against tools.ts in both directions, so the list can't go stale);
 * - through dispatch and the real loopback server, every guard answers with the
 *   documented shape: JSON-RPC -32000, a message, `data.code`, no result;
 * - docs/MCP-ERRORS.md shows the same per-tool table the code publishes.
 */

let userData = tmpdir()
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '9.9.9', getLocale: () => 'en-US' },
  // No displays: capture_screen with a display_id is a NOT_FOUND, and nothing is ever grabbed.
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }) },
  desktopCapturer: {}
}))

const { TOOLS } = await import('./tools')
const { DISPATCH_ERROR_CODES, TOOL_ERROR_MEANINGS } = await import('./errors')
const { ERRORS_META_KEY, describeTools, dispatch, errorCodesOf } = await import('./dispatch')
const { startMcpServer } = await import('./server')
type ToolDefinition = (typeof TOOLS)[number]

const ROOT = resolve(__dirname, '../../..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const TOOLS_SRC = read('src/main/mcp/tools.ts')
/**
 * Modules outside tools.ts whose functions throw ToolError, and the tool-body
 * calls that reach them. A test below fails when another module starts throwing
 * ToolError, so a code can't reach a tool unseen.
 */
const CALLEES: Record<string, string> = { runFlowFile: 'src/main/flow-run.ts', flowFromSidecar: 'src/main/mcp/flow-export.ts' }
/** Files that may throw ToolError: these, plus CALLEES. The rest throw plain errors (INTERNAL). */
const TOOL_ERROR_FILES = ['src/main/mcp/tools.ts', 'src/main/mcp/errors.ts', 'src/main/mcp/dispatch.ts', 'src/main/mcp/server.ts', 'src/main/mcp/resources.ts', 'src/main/mcp/prompts.ts']
const DOC_PATH = 'docs/MCP-ERRORS.md'

type JsonSchema = { type?: string; enum?: unknown[]; properties?: Record<string, JsonSchema>; required?: string[]; anyOf?: JsonSchema[] }

function inputSchemaOf(tool: ToolDefinition): JsonSchema {
  return describeTools([tool])[0].inputSchema as JsonSchema
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const directCodes = (src: string): Set<string> => new Set([...src.matchAll(/new ToolError\(\s*'([A-Z_]+)'/g)].map((m) => m[1]))

/** Top-level functions of a module (`function x(` at column 0, up to the next `}` at column 0). */
function topLevelFunctions(src: string): Map<string, string> {
  const fns = new Map<string, string>()
  for (const m of src.matchAll(/^(?:export )?(?:async )?function (\w+)\([\s\S]*?^\}/gm)) fns.set(m[1], m[0])
  return fns
}

/**
 * What each helper a tool body can call raises: tools.ts's own functions and
 * errors.ts's constructors (transitively), and the CALLEES modules as a whole.
 */
function helperCodes(): Map<string, Set<string>> {
  const bodies = new Map([...topLevelFunctions(TOOLS_SRC), ...topLevelFunctions(read('src/main/mcp/errors.ts'))])
  const codes = new Map([...bodies].map(([n, b]) => [n, directCodes(b)]))
  for (const [fn, file] of Object.entries(CALLEES)) codes.set(fn, directCodes(read(file)))
  for (let changed = true; changed; ) {
    changed = false
    for (const [n, b] of bodies) {
      for (const [callee, cs] of codes) {
        if (callee === n || !new RegExp(`\\b${callee}\\(`).test(b)) continue
        for (const c of cs) if (!codes.get(n)!.has(c)) (codes.get(n)!.add(c), (changed = true))
      }
    }
  }
  return codes
}

/** Codes a tool body can raise, directly or through a helper. */
function codesRaisedBy(src: string, helpers: Map<string, Set<string>>): Set<string> {
  const codes = directCodes(src)
  for (const [fn, cs] of helpers) if (new RegExp(`\\b${fn}\\(`).test(src)) for (const c of cs) codes.add(c)
  return codes
}

/** Each `defineTool({ ... })` block of tools.ts by tool name: from the call to its closing `})` at column 0. */
function toolBlocks(): Map<string, string> {
  const blocks = new Map<string, string>()
  for (const m of TOOLS_SRC.matchAll(/defineTool\(\{\s*name: '([a-z_]+)'[\s\S]*?^\}\)/gm)) blocks.set(m[1], m[0])
  return blocks
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) return sourceFiles(rel)
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : []
  })
}

/** A value of the wrong JSON type for a property, so its schema must refuse it. */
function wrongValueFor(prop: JsonSchema): unknown {
  if (prop.enum) return '__not_one_of_them__'
  switch (prop.type) {
    case 'string':
      return 42
    case 'number':
    case 'integer':
    case 'boolean':
    case 'array':
      return 'not the right type'
    case 'object':
      return 'not an object'
    default:
      throw new Error(`no wrong value for schema ${JSON.stringify(prop)}: teach wrongValueFor this shape`)
  }
}

/**
 * Arguments the tool's schema must refuse, and the path the refusal must name:
 * nothing at all when something is required, otherwise the first property with
 * the wrong type.
 */
function badArgsFor(tool: ToolDefinition): { args: Record<string, unknown>; path: string } {
  const schema = inputSchemaOf(tool)
  const required = schema.required ?? []
  if (required.length > 0) return { args: {}, path: required[0] }
  const [name, prop] = Object.entries(schema.properties ?? {})[0]
  return { args: { [name]: wrongValueFor(prop) }, path: name }
}

/** The per-tool table docs/MCP-ERRORS.md must contain, generated from TOOLS. */
function renderToolTable(): string {
  const rows = TOOLS.map((t) => {
    const own = t.errors
    return `| \`${t.name}\` | ${own.length ? own.map((c) => `\`${c}\``).join(', ') : '(none)'} |`
  })
  return ['| Tool | Its own codes (on top of the dispatch codes) |', '|---|---|', ...rows].join('\n')
}

function renderCodeTable(): string {
  const rows = Object.entries(TOOL_ERROR_MEANINGS).map(
    ([code, meaning]) =>
      `| \`${code}\` | ${DISPATCH_ERROR_CODES.includes(code as never) ? 'any tool' : code === 'UNKNOWN_TOOL' ? 'a call naming no tool' : 'declared'} | ${meaning} |`
  )
  return ['| `data.code` | Who can return it | Meaning |', '|---|---|---|', ...rows].join('\n')
}

/* ------------------------------------------------------------------ *
 * Schema contract
 * ------------------------------------------------------------------ */

describe('every MCP tool publishes a usable input schema', () => {
  it('has unique snake_case names', () => {
    const names = TOOLS.map((t) => t.name)
    expect(new Set(names).size, `duplicate tool names in ${names.join(', ')}`).toBe(names.length)
    for (const n of names) expect(n, `tool name ${n} should be snake_case`).toMatch(/^[a-z]+(_[a-z]+)*$/)
  })

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s: object schema, required names declared properties, JSON-clean', (name, tool) => {
    const schema = inputSchemaOf(tool)
    expect(schema.type, `${name} inputSchema.type`).toBe('object')
    const props = Object.keys(schema.properties ?? {})
    for (const r of schema.required ?? []) expect(props, `${name} requires "${r}" but has no such property`).toContain(r)
    expect(JSON.parse(JSON.stringify(schema)), `${name} inputSchema should survive a JSON round trip unchanged`).toEqual(schema)
    expect(tool.description.length, `${name} needs a description an agent can read`).toBeGreaterThan(20)
  })
})

/* ------------------------------------------------------------------ *
 * Declared error codes
 * ------------------------------------------------------------------ */

describe('every MCP tool declares the error codes it can return', () => {
  const blocks = toolBlocks()

  it('finds a defineTool block in tools.ts for every tool in TOOLS', () => {
    expect([...blocks.keys()].sort()).toEqual(TOOLS.map((t) => t.name).sort())
  })

  const helpers = helperCodes()

  it('sees every module that throws ToolError (others throw plain errors, which end as INTERNAL)', () => {
    const throwing = sourceFiles('src/main').filter((f) => /new ToolError\(/.test(read(f)))
    expect(throwing.sort(), 'a new module throws ToolError: add it to CALLEES (with the call that reaches it) or TOOL_ERROR_FILES').toEqual(
      [...TOOL_ERROR_FILES, ...Object.values(CALLEES)].sort()
    )
    expect(helpers.get('requireItem'), 'the helper scan should see requireItem').toEqual(new Set(['NOT_FOUND']))
    expect(helpers.get('notImplemented'), 'the helper scan should see errors.ts').toEqual(new Set(['NOT_IMPLEMENTED']))
  })

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s: declared codes match what its body raises', (name, tool) => {
    expect(Array.isArray(tool.errors), `${name} must declare errors (use [] when its body adds none)`).toBe(true)
    const declared = [...tool.errors].sort()
    for (const c of declared) {
      expect(Object.keys(TOOL_ERROR_MEANINGS), `${name} declares unknown code ${c}`).toContain(c)
      expect(DISPATCH_ERROR_CODES, `${name} declares ${c}, which every call can return already: drop it`).not.toContain(c)
    }
    const raised = [...codesRaisedBy(blocks.get(name) ?? '', helpers)].filter((c) => !DISPATCH_ERROR_CODES.includes(c as never)).sort()
    expect(declared, `${name}: errors: [...] in tools.ts vs the codes its body (and the helpers it calls) raises`).toEqual(raised)
  })

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s: tools/list publishes dispatch codes + its own under _meta', (name, tool) => {
    const meta = describeTools([tool])[0]._meta?.[ERRORS_META_KEY]
    expect(meta, `${name} _meta["${ERRORS_META_KEY}"]`).toEqual([...DISPATCH_ERROR_CODES, ...tool.errors])
    expect(errorCodesOf(tool)).toEqual(meta)
  })
})

/* ------------------------------------------------------------------ *
 * Guards through dispatch, for every tool
 * ------------------------------------------------------------------ */

describe('every MCP tool answers the dispatch guards with typed codes and never runs its body', () => {
  const TOKEN = 't'.repeat(43)
  let ran: string[] = []
  /** The real tool with a body that records it was reached. */
  const spied = (tool: ToolDefinition): ToolDefinition => ({ ...tool, run: async () => void ran.push(tool.name) })

  async function codeOf(p: Promise<unknown>): Promise<{ code: string; detail: Record<string, unknown> }> {
    try {
      await p
    } catch (err) {
      const e = err as { code: string; detail: Record<string, unknown> }
      return { code: e.code, detail: e.detail }
    }
    throw new Error('expected the call to be refused, but it succeeded')
  }

  const call = (tool: ToolDefinition, over: { paused?: boolean; authorization?: string | null; origin?: string | null; args?: unknown }) => {
    ran = []
    return dispatch(
      { token: TOKEN, tools: [spied(tool)], isPaused: async () => over.paused ?? false },
      {
        name: tool.name,
        args: over.args ?? badArgsFor(tool).args,
        authorization: over.authorization === undefined ? `Bearer ${TOKEN}` : over.authorization,
        origin: over.origin ?? null,
        callId: 'c1'
      }
    )
  }

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s: UNAUTHORIZED, FORBIDDEN_ORIGIN, AGENT_ACCESS_PAUSED, INVALID_ARGUMENTS', async (name, tool) => {
    expect((await codeOf(call(tool, { authorization: null }))).code, `${name} with no token`).toBe('UNAUTHORIZED')
    expect((await codeOf(call(tool, { origin: 'http://evil.test' }))).code, `${name} from a web page`).toBe('FORBIDDEN_ORIGIN')
    expect((await codeOf(call(tool, { paused: true }))).code, `${name} while paused`).toBe('AGENT_ACCESS_PAUSED')

    const bad = badArgsFor(tool)
    const refused = await codeOf(call(tool, { args: bad.args }))
    expect(refused.code, `${name} with ${JSON.stringify(bad.args)}`).toBe('INVALID_ARGUMENTS')
    const paths = (refused.detail.issues as { path: string; message: string }[]).map((i) => i.path)
    expect(paths, `${name}: the refusal should name the bad field`).toContain(bad.path)
    expect(ran, `${name}: no guard may let the body run`).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * The wire shape, over the real loopback server and the real tool bodies
 * ------------------------------------------------------------------ */

describe('tool errors on the wire (real server, real tools)', () => {
  let handle: Awaited<ReturnType<typeof startMcpServer>>

  beforeAll(async () => {
    userData = await fs.mkdtemp(join(tmpdir(), 'nawi-mcp-contract-'))
    handle = await startMcpServer({ isPaused: async () => false, runsRoot: join(userData, 'runs') })
    expect(handle, 'the server should start on loopback').not.toBeNull()
  })

  afterAll(async () => {
    await handle?.close()
    await fs.rm(userData, { recursive: true, force: true })
  })

  async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const res = await postJson(
      handle!.info.url,
      { 'content-type': 'application/json', authorization: `Bearer ${handle!.info.token}` },
      JSON.stringify({ jsonrpc: '2.0', id: 7, method, params })
    )
    expect(res.status, `${method} ${JSON.stringify(params)}: a refused call is still HTTP 200`).toBe(200)
    return JSON.parse(res.text)
  }

  /** The documented shape: -32000, a message, data.code (+ detail), id echoed, no result. */
  function expectToolError(body: Record<string, any>, code: string, context: string): Record<string, any> {
    expect(body.result, `${context}: no result next to an error (${JSON.stringify(body)})`).toBeUndefined()
    expect(body, `${context}: ${JSON.stringify(body)}`).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32000, data: { code } } })
    expect(typeof body.error.message, `${context}: error.message`).toBe('string')
    expect(body.error.message.length, `${context}: error.message should explain the refusal`).toBeGreaterThan(0)
    return body.error.data
  }

  it('lists every tool with its error codes under _meta', async () => {
    const body = await rpc('tools/list', {})
    const listed = Object.fromEntries((body.result.tools as { name: string; _meta?: Record<string, unknown> }[]).map((t) => [t.name, t._meta?.[ERRORS_META_KEY]]))
    expect(listed).toEqual(Object.fromEntries(TOOLS.map((t) => [t.name, errorCodesOf(t)])))
  })

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s: schema refusal is -32000 INVALID_ARGUMENTS with issues', async (name, tool) => {
    const bad = badArgsFor(tool)
    const data = expectToolError(await rpc('tools/call', { name, arguments: bad.args }), 'INVALID_ARGUMENTS', name)
    expect(data.issues, `${name} issues`).toEqual(expect.arrayContaining([expect.objectContaining({ path: bad.path, message: expect.any(String) })]))
  })

  it('answers an unknown tool with UNKNOWN_TOOL naming it', async () => {
    expect(expectToolError(await rpc('tools/call', { name: 'rm_rf' }), 'UNKNOWN_TOOL', 'rm_rf')).toMatchObject({ tool: 'rm_rf' })
  })

  it.each([
    { tool: 'capture_screen', args: { display_id: 999 }, code: 'NOT_FOUND', detail: { display_id: 999 } },
    { tool: 'capture_region', args: { display_id: 999, x: 0, y: 0, width: 10, height: 10 }, code: 'NOT_FOUND', detail: { display_id: 999 } },
    { tool: 'get_state_layer', args: { capture_id: 'nope', revision: '../v1' }, code: 'INVALID_ARGUMENTS', detail: { issues: [expect.objectContaining({ path: 'revision' })] } },
    { tool: 'export_flow', args: { capture_id: 'nope', revision: 'bogus' }, code: 'INVALID_ARGUMENTS', detail: { issues: [expect.objectContaining({ path: 'revision' })] } },
    { tool: 'start_recording', args: {}, code: 'NOT_IMPLEMENTED', detail: { tool: 'start_recording' } },
    { tool: 'stop_recording', args: {}, code: 'NOT_IMPLEMENTED', detail: { tool: 'stop_recording' } },
    { tool: 'capture_element', args: { selector: '#save' }, code: 'NO_BROWSER_ATTACHED', detail: { selector: '#save' } },
    { tool: 'get_capture', args: { capture_id: 'nope' }, code: 'NOT_FOUND', detail: { capture_id: 'nope' } },
    { tool: 'get_state_layer', args: { capture_id: 'nope' }, code: 'NOT_FOUND', detail: { capture_id: 'nope' } },
    { tool: 'annotate', args: { capture_id: 'nope', shapes: [{ kind: 'rect', x: 0, y: 0, width: 1, height: 1, color: '#f00', strokeWidth: 1 }] }, code: 'NOT_FOUND', detail: { capture_id: 'nope' } },
    { tool: 'redact', args: { capture_id: 'nope', region: { x: 0, y: 0, width: 1, height: 1 } }, code: 'NOT_FOUND', detail: { capture_id: 'nope' } },
    { tool: 'export_guide', args: { capture_id: 'nope' }, code: 'NOT_FOUND', detail: { capture_id: 'nope' } },
    { tool: 'export_flow', args: { capture_id: 'nope' }, code: 'NOT_FOUND', detail: { capture_id: 'nope' } },
    { tool: 'get_run', args: { run_id: '20261102T103900123Z-a1b2c3' }, code: 'NOT_FOUND', detail: { run_id: '20261102T103900123Z-a1b2c3' } },
    { tool: 'get_heal_proposals', args: { run_id: '20261102T103900123Z-a1b2c3' }, code: 'NOT_FOUND', detail: { run_id: '20261102T103900123Z-a1b2c3' } },
    // Inside the home folder: a path outside it is refused as INVALID_ARGUMENTS before the disk is looked at.
    { tool: 'run_flow', args: { file: MISSING_FLOW }, code: 'NOT_FOUND', detail: { file: MISSING_FLOW } }
  ])('$tool: a real refusal is -32000 with data.code $code', async ({ tool, args, code, detail }) => {
    const def = TOOLS.find((t) => t.name === tool)
    expect(errorCodesOf(def!), `${tool} must publish ${code}`).toContain(code)
    expect(expectToolError(await rpc('tools/call', { name: tool, arguments: args }), code, tool)).toMatchObject(detail)
  })

  it('carries a tool that succeeds as a result, never an error (list_runs on an empty store)', async () => {
    const body = await rpc('tools/call', { name: 'list_runs', arguments: {} })
    expect(body.error, JSON.stringify(body)).toBeUndefined()
    expect(body.result).toMatchObject({ isError: false, structuredContent: { runs: [], count: 0 } })
  })
})

/* ------------------------------------------------------------------ *
 * The documentation
 * ------------------------------------------------------------------ */

/**
 * The doc's tables live between `<!-- generated:<name> -->` and `<!-- /generated -->`.
 * Regenerate them with `UPDATE_MCP_ERRORS_DOC=1 npx vitest run src/main/mcp/tools.contract.test.ts`.
 */
function withTable(doc: string, name: string, table: string): string {
  const re = new RegExp(`(<!-- generated:${name} -->\\n)[\\s\\S]*?(<!-- /generated -->)`)
  if (!re.test(doc)) throw new Error(`${DOC_PATH} has no <!-- generated:${name} --> ... <!-- /generated --> block`)
  return doc.replace(re, (_m, open: string, close: string) => `${open}${table}\n${close}`)
}

describe(`${DOC_PATH} documents the error shape the code produces`, () => {
  const current = read(DOC_PATH)
  const expected = withTable(withTable(current, 'codes', renderCodeTable()), 'tools', renderToolTable())
  if (process.env.UPDATE_MCP_ERRORS_DOC === '1' && expected !== current) writeFileSync(join(ROOT, DOC_PATH), expected)

  it('has the code and per-tool tables generated from TOOL_ERROR_MEANINGS and TOOLS', () => {
    expect(process.env.UPDATE_MCP_ERRORS_DOC === '1' ? read(DOC_PATH) : current, `${DOC_PATH} is stale: run UPDATE_MCP_ERRORS_DOC=1 npx vitest run src/main/mcp/tools.contract.test.ts`).toBe(expected)
  })

  it('names the JSON-RPC codes and the _meta key the server uses', () => {
    for (const s of ['-32000', '-32602', '-32002', ERRORS_META_KEY, 'data.code']) expect(current, `${DOC_PATH} should mention ${s}`).toContain(s)
  })
})
