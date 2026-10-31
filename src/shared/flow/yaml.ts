import { Document, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit } from 'yaml'
import type { Node as YamlNode } from 'yaml'
import type { z } from 'zod'
import { FlowSchema, type Flow } from './schema'

/**
 * Flow files as YAML text.
 *
 * `parseFlow` keeps the parsed `yaml` Document next to the validated flow, so an
 * editor can change one value (`document.setIn([...], v)`) and write
 * `document.toString()` back with the author's comments, key order and quoting
 * intact (`formatFlowDocument`). `stringifyFlow` writes a fresh file in the canonical layout.
 */

export interface FlowError {
  /** `steps[2].target.selectors[0]`, or `(root)` for the document itself. */
  path: string
  message: string
  /** 1-based position in the text, pointing at the offending key or value. */
  line: number
  col: number
}

export type ParseFlowResult =
  | { ok: true; flow: Flow; document: Document.Parsed }
  | { ok: false; errors: FlowError[] }

type PathSegment = string | number

export function formatPath(path: readonly PathSegment[]): string {
  if (path.length === 0) return '(root)'
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out ? `.${seg}` : seg
  }
  return out
}

/** `file:line:col path: message`, one per line — the form editors and terminals link. */
export function formatFlowErrors(errors: readonly FlowError[], file = 'flow.nawi.yaml'): string {
  return errors.map((e) => `${file}:${e.line}:${e.col} ${e.path}: ${e.message}`).join('\n')
}

function nodeAt(doc: Document.Parsed, path: readonly PathSegment[]): YamlNode | null {
  let node: unknown = doc.contents
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg))
      if (!pair) return null
      node = pair.value
    } else if (isSeq(node) && typeof seg === 'number') {
      node = node.items[seg]
    } else {
      return null
    }
    if (node == null) return null
  }
  return (node as YamlNode | null) ?? null
}

function keyNodeAt(doc: Document.Parsed, path: readonly PathSegment[], key: string): YamlNode | null {
  const parent = nodeAt(doc, path)
  if (!isMap(parent)) return null
  const pair = parent.items.find((p) => isPair(p) && isScalar(p.key) && String(p.key.value) === key)
  return (pair?.key as YamlNode | undefined) ?? null
}

/**
 * The closest existing node for an issue: the key itself for an unknown key,
 * otherwise the deepest node along the path (a missing field points at the
 * object that lacks it).
 */
function positionFor(
  doc: Document.Parsed,
  lines: LineCounter,
  path: readonly PathSegment[],
  key?: string
): { line: number; col: number } {
  let node: YamlNode | null = key === undefined ? null : keyNodeAt(doc, path, key)
  for (let len = path.length; !node && len >= 0; len--) node = nodeAt(doc, path.slice(0, len))
  const offset = node?.range?.[0] ?? 0
  return lines.linePos(offset)
}

function zodIssues(doc: Document.Parsed, lines: LineCounter, issues: readonly z.core.$ZodIssue[]): FlowError[] {
  const errors: FlowError[] = []
  for (const issue of issues) {
    const path = issue.path.filter((s): s is PathSegment => typeof s !== 'symbol')
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        errors.push({
          path: formatPath([...path, key]),
          message: `unknown key "${key}"`,
          ...positionFor(doc, lines, path, key)
        })
      }
      continue
    }
    errors.push({ path: formatPath(path), message: issue.message, ...positionFor(doc, lines, path) })
  }
  return errors.sort((a, b) => a.line - b.line || a.col - b.col)
}

/**
 * How flow text is written: no line folding (a long note stays one line).
 * Inline collections are spaced `[ a, b ]` / `{ k: v }`; that spacing is the one
 * thing a write-back normalizes. Use `formatFlowDocument` to write back a
 * document from `parseFlow` so edited files keep the same layout.
 */
export const FLOW_TO_STRING = { lineWidth: 0 } as const

export function formatFlowDocument(document: Document): string {
  return document.toString(FLOW_TO_STRING)
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Parse and validate a flow file. Never throws on bad input. */
export function parseFlow(text: string): ParseFlowResult {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true, version: '1.2' })

  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const pos = lineCounter.linePos(e.pos[0])
        return { path: '(yaml)', message: e.message.split('\n')[0], line: pos.line, col: pos.col }
      })
    }
  }

  // `__proto__` as a key is not data: converting it to a JS object sets the
  // prototype instead of adding a key, so `vars: { __proto__: x }` would vanish
  // and every `${vars.__proto__}` would then read as "undeclared". Refuse these
  // keys anywhere, at their position.
  const reserved: FlowError[] = []
  visit(doc, {
    Pair(_, pair) {
      if (isScalar(pair.key) && RESERVED_KEYS.has(String(pair.key.value))) {
        const pos = lineCounter.linePos(pair.key.range?.[0] ?? 0)
        reserved.push({
          path: '(yaml)',
          message: `"${String(pair.key.value)}" is a reserved name and cannot be used as a key`,
          line: pos.line,
          col: pos.col
        })
      }
    }
  })
  if (reserved.length > 0) return { ok: false, errors: reserved }

  let data: unknown
  try {
    data = doc.toJS({ maxAliasCount: 50 })
  } catch (err) {
    return { ok: false, errors: [{ path: '(yaml)', message: (err as Error).message, line: 1, col: 1 }] }
  }

  const result = FlowSchema.safeParse(data)
  if (!result.success) return { ok: false, errors: zodIssues(doc, lineCounter, result.error.issues) }
  return { ok: true, flow: result.data, document: doc }
}

/**
 * Write a flow in the canonical layout: block style, selectors and boxes inline
 * (`- { role: textbox, name: Email }`), no line folding. Validates first, so a
 * file this writes always parses back to an equal flow.
 */
export function stringifyFlow(flow: Flow): string {
  const valid = FlowSchema.parse(flow)
  const doc = new Document(valid)
  visit(doc, {
    Pair(_, pair) {
      const key = isScalar(pair.key) ? pair.key.value : null
      if ((key === 'bbox' || key === 'delta') && isSeq(pair.value)) pair.value.flow = true
      if (key === 'selectors' && isSeq(pair.value)) {
        for (const item of pair.value.items) if (isMap(item)) item.flow = true
      }
    }
  })
  return formatFlowDocument(doc)
}
