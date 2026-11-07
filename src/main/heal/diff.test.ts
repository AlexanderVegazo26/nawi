import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_TABLE_CELLS, unifiedDiff } from './diff'

/** Applies `patch` to a file holding `before` with git apply (a real patch tool) and returns the result. */
function applyWithGit(before: string, patch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nawi-diff-'))
  try {
    writeFileSync(join(dir, 'flow.nawi.yaml'), before)
    writeFileSync(join(dir, 'p.diff'), patch)
    execFileSync('git', ['apply', 'p.diff'], { cwd: dir, stdio: 'pipe' })
    return readFileSync(join(dir, 'flow.nawi.yaml'), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Deterministic RNG (mulberry32), so the generated cases are the same every run. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('unifiedDiff', () => {
  it('is empty for equal texts', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'f')).toBe('')
  })

  it('prints a diff -u hunk with 3 lines of context and 1-based ranges', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n') + '\n'
    const after = before.replace('5\n', 'five\n')
    expect(unifiedDiff(before, after, 'flow.nawi.yaml')).toBe(
      ['--- a/flow.nawi.yaml', '+++ b/flow.nawi.yaml', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8', ''].join('\n')
    )
  })

  it('keeps far-apart changes in separate hunks and near ones in one', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const far = [...lines]
    far[2] = 'x'
    far[25] = 'y'
    expect(unifiedDiff(lines.join('\n') + '\n', far.join('\n') + '\n', 'f').match(/^@@/gm), 'two changes 23 lines apart').toHaveLength(2)
    const near = [...lines]
    near[2] = 'x'
    near[8] = 'y'
    expect(unifiedDiff(lines.join('\n') + '\n', near.join('\n') + '\n', 'f').match(/^@@/gm), 'two changes 6 lines apart').toHaveLength(1)
  })

  it('marks a missing newline at the end of file the way diff does, and git applies it', () => {
    const patch = unifiedDiff('a\nb', 'a\nc\n', 'f')
    expect(patch).toContain('-b\n\\ No newline at end of file\n+c\n')
    expect(applyWithGit('a\nb', patch.replaceAll('a/f', 'a/flow.nawi.yaml').replaceAll('b/f', 'b/flow.nawi.yaml'))).toBe('a\nc\n')
  })

  it('produces patches git apply turns back into the new text (200 seeded random edits)', () => {
    const next = rng(20261107)
    for (let n = 0; n < 200; n++) {
      const size = Math.floor(next() * 40)
      const before = Array.from({ length: size }, () => `k${Math.floor(next() * 6)}: v`)
      const after = [...before]
      const edits = 1 + Math.floor(next() * 4)
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(next() * (after.length + 1))
        const roll = next()
        if (roll < 0.33 && after.length > 0) after.splice(Math.min(at, after.length - 1), 1)
        else if (roll < 0.66) after.splice(at, 0, `new${e}: v`)
        else if (after.length > 0) after[Math.min(at, after.length - 1)] = `changed${e}: v`
      }
      const a = before.length ? before.join('\n') + '\n' : ''
      const b = after.length ? after.join('\n') + '\n' : ''
      const patch = unifiedDiff(a, b, 'flow.nawi.yaml')
      if (a === b) {
        expect(patch, `case ${n}`).toBe('')
        continue
      }
      expect(applyWithGit(a, patch), `case ${n}: git apply of\n${patch}\nto\n${a}`).toBe(b)
    }
  }, 60_000)

  it('falls back to one replaced block when the changed middle is too large for the table', () => {
    const side = Math.ceil(Math.sqrt(MAX_TABLE_CELLS)) + 1
    const before = Array.from({ length: side }, (_, i) => `a${i}`).join('\n') + '\n'
    const after = Array.from({ length: side }, (_, i) => `b${i}`).join('\n') + '\n'
    const patch = unifiedDiff(before, after, 'f')
    expect(patch.split('\n').filter((l) => l.startsWith('-a')).length, 'every old line removed').toBe(side)
    expect(patch.split('\n').filter((l) => l.startsWith('+b')).length, 'every new line added').toBe(side)
  })
})
