import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { flowJsonSchema, formatFlowDocument, formatFlowErrors, parseFlow } from '../shared/flow'

const root = join(__dirname, '..', '..')
const SCHEMA_FILE = join(root, 'docs', 'schemas', 'flow.v1.schema.json')
const EXAMPLE = join(root, 'src', 'shared', 'flow', '__fixtures__', 'create-invoice.nawi.yaml')

describe('flow files on disk', () => {
  it('the committed JSON Schema matches the flow model (regenerate: WRITE_FLOW_SCHEMA=1 npx vitest run src/main/flow-files.test.ts)', () => {
    const generated = JSON.stringify(flowJsonSchema(), null, 2) + '\n'
    if (process.env.WRITE_FLOW_SCHEMA === '1') writeFileSync(SCHEMA_FILE, generated)
    expect(readFileSync(SCHEMA_FILE, 'utf8'), `${SCHEMA_FILE} is stale`).toBe(generated)
  })

  it('the example flow parses, and writes back byte for byte with its comments', () => {
    const text = readFileSync(EXAMPLE, 'utf8')
    const r = parseFlow(text)
    if (!r.ok) throw new Error(formatFlowErrors(r.errors, EXAMPLE))
    expect(r.flow.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6'])
    expect(r.flow.vars, 'the example must keep the password out of the file').toEqual({
      email: '${env.TEST_EMAIL}',
      password: '${secret.app_password}'
    })
    expect(formatFlowDocument(r.document)).toBe(text)
  })
})
