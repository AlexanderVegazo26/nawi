/**
 * A unified diff of two texts, line by line (`diff -u` layout, 3 lines of
 * context), for the healing proposals (roadmap F6): the reviewable YAML patch.
 * No dependency: flow files are at most 1 MiB, and a proposal changes a few
 * lines, so the common head and tail are cut first and only the middle goes
 * through an LCS table. A middle too large for the table (over
 * MAX_TABLE_CELLS) is shown as one block replaced, which is still a correct
 * patch, only a longer one.
 */

export const MAX_TABLE_CELLS = 4_000_000

type Op = { kind: ' ' | '-' | '+'; line: string }

function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === '') return { lines: [], finalNewline: true }
  const finalNewline = text.endsWith('\n')
  const lines = (finalNewline ? text.slice(0, -1) : text).split('\n')
  return { lines, finalNewline }
}

/** The edit script of the middle part, by an LCS table (or one replaced block when it would be too large). */
function middleOps(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((line) => ({ kind: '+', line }))
  if (b.length === 0) return a.map((line) => ({ kind: '-', line }))
  if (a.length * b.length > MAX_TABLE_CELLS) {
    return [...a.map((line): Op => ({ kind: '-', line })), ...b.map((line): Op => ({ kind: '+', line }))]
  }
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] })
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: '-', line: a[i++] })
    } else {
      ops.push({ kind: '+', line: b[j++] })
    }
  }
  while (i < a.length) ops.push({ kind: '-', line: a[i++] })
  while (j < b.length) ops.push({ kind: '+', line: b[j++] })
  return ops
}

/**
 * `--- a/<from>` / `+++ b/<to>` and `@@` hunks; '' when the texts are equal.
 * A missing newline at the end of either side is marked the way `diff` does.
 */
export function unifiedDiff(before: string, after: string, fromName: string, toName: string = fromName, context = 3): string {
  if (before === after) return ''
  const a = splitLines(before)
  const b = splitLines(after)
  // The last line's newline is part of the comparison: mark a line without one so it differs.
  const NO_EOL = '\u0000no-eol'
  if (!a.finalNewline && a.lines.length > 0) a.lines[a.lines.length - 1] += NO_EOL
  if (!b.finalNewline && b.lines.length > 0) b.lines[b.lines.length - 1] += NO_EOL

  let head = 0
  while (head < a.lines.length && head < b.lines.length && a.lines[head] === b.lines[head]) head++
  let tail = 0
  while (
    tail < a.lines.length - head &&
    tail < b.lines.length - head &&
    a.lines[a.lines.length - 1 - tail] === b.lines[b.lines.length - 1 - tail]
  ) {
    tail++
  }
  const ops: Op[] = [
    ...a.lines.slice(0, head).map((line): Op => ({ kind: ' ', line })),
    ...middleOps(a.lines.slice(head, a.lines.length - tail), b.lines.slice(head, b.lines.length - tail)),
    ...a.lines.slice(a.lines.length - tail).map((line): Op => ({ kind: ' ', line }))
  ]

  // Group changes that are within 2 * context lines of each other into one hunk.
  const changed = ops.map((op, k) => (op.kind === ' ' ? -1 : k)).filter((k) => k >= 0)
  const hunks: Array<[number, number]> = []
  for (const k of changed) {
    const last = hunks[hunks.length - 1]
    if (last && k - last[1] <= 2 * context + 1) last[1] = k
    else hunks.push([k, k])
  }

  const out = [`--- a/${fromName}`, `+++ b/${toName}`]
  for (const [first, last] of hunks) {
    const start = Math.max(0, first - context)
    const end = Math.min(ops.length - 1, last + context)
    // Line numbers (1-based) where the hunk starts in each file.
    let aLine = 1
    let bLine = 1
    for (let k = 0; k < start; k++) {
      if (ops[k].kind !== '+') aLine++
      if (ops[k].kind !== '-') bLine++
    }
    const slice = ops.slice(start, end + 1)
    const aCount = slice.filter((op) => op.kind !== '+').length
    const bCount = slice.filter((op) => op.kind !== '-').length
    const range = (line: number, count: number): string => `${count === 0 ? line - 1 : line}${count === 1 ? '' : `,${count}`}`
    out.push(`@@ -${range(aLine, aCount)} +${range(bLine, bCount)} @@`)
    for (const op of slice) {
      if (op.line.endsWith(NO_EOL)) out.push(`${op.kind}${op.line.slice(0, -NO_EOL.length)}`, '\\ No newline at end of file')
      else out.push(`${op.kind}${op.line}`)
    }
  }
  return `${out.join('\n')}\n`
}
