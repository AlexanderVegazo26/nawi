import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { BUILD_SCRIPTS, SIGNING_VARS, withoutEmptySigningVars } from './release-build.ts'

const root = path.resolve(import.meta.dirname, '..')

describe('withoutEmptySigningVars', () => {
  it('drops signing variables that a missing secret left empty or blank', () => {
    const env = withoutEmptySigningVars({ CSC_LINK: '', CSC_KEY_PASSWORD: '  ', APPLE_ID: '', PATH: '/bin' })
    expect(Object.keys(env), 'empty CSC_LINK must be unset: electron-builder reads "" as a cert path').toEqual(['PATH'])
  })

  it('keeps signing variables that hold a value, so a configured secret still signs', () => {
    const env = withoutEmptySigningVars({ CSC_LINK: 'base64cert', CSC_KEY_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAM' })
    expect(env).toEqual({ CSC_LINK: 'base64cert', CSC_KEY_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAM' })
  })

  it('leaves unrelated empty variables alone and does not change its input', () => {
    const input = { CSC_LINK: '', SOME_FLAG: '' }
    const env = withoutEmptySigningVars(input)
    expect(env, 'only signing variables are filtered').toEqual({ SOME_FLAG: '' })
    expect(input, 'the caller env is not mutated').toEqual({ CSC_LINK: '', SOME_FLAG: '' })
  })
})

interface Step {
  name?: string
  run?: string
  env?: Record<string, string>
}

describe('release.yml build step', () => {
  const workflow = parse(readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')) as {
    jobs: { build: { steps: Step[]; strategy: { matrix: { include: { script: string }[] } } } }
  }
  const build = workflow.jobs.build
  const step = build.steps.find((s) => s.name === 'Build installers')

  it('builds through scripts/release-build.ts so empty secrets are unset before electron-builder runs', () => {
    expect(step, 'release.yml build job has no "Build installers" step').toBeDefined()
    expect(step?.run?.trim(), 'a direct `npm run dist:*` passes an empty CSC_LINK on (macOS: "<repo> not a file")').toBe(
      'node scripts/release-build.ts ${{ matrix.script }}'
    )
  })

  it('passes only secrets the wrapper knows how to drop when empty', () => {
    const fromSecrets = Object.entries(step?.env ?? {})
      .filter(([, value]) => /secrets\.(?!GITHUB_TOKEN\b)/.test(value))
      .map(([name]) => name)
    expect(fromSecrets.length, 'expected the signing secrets in the step env').toBeGreaterThan(0)
    const unknown = fromSecrets.filter((name) => !(SIGNING_VARS as readonly string[]).includes(name))
    expect(unknown, 'add these to SIGNING_VARS in scripts/release-build.ts').toEqual([])
  })

  it('runs only build scripts the wrapper accepts', () => {
    const scripts = build.strategy.matrix.include.map((entry) => entry.script)
    expect(scripts.filter((s) => !(BUILD_SCRIPTS as readonly string[]).includes(s))).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('scripts/release-build.ts command', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nawi-release-build-'))
    // A stand-in npm that records what it was asked to run and with which signing variables.
    const fakeNpm = path.join(dir, 'npm')
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nnode -e 'const k=["CSC_LINK","CSC_KEY_PASSWORD","APPLE_ID"];require("fs").writeFileSync(process.argv[1],JSON.stringify({args:process.argv.slice(2),env:Object.fromEntries(k.filter(n=>n in process.env).map(n=>[n,process.env[n]]))}))' "${dir}/seen.json" "$@"\nexit "\${FAKE_NPM_EXIT:-0}"\n`
    )
    chmodSync(fakeNpm, 0o755)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function run(args: string[], extra: Record<string, string>) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/release-build.ts'), ...args], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, ...extra },
      encoding: 'utf8'
    })
    return result
  }

  it('runs the npm build script without the empty signing variables', () => {
    const result = run(['dist:mac'], { CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_ID: 'me@example.test' })
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    const seen = JSON.parse(readFileSync(path.join(dir, 'seen.json'), 'utf8'))
    expect(seen).toEqual({ args: ['run', 'dist:mac'], env: { APPLE_ID: 'me@example.test' } })
    expect(result.stdout).toContain('unset empty CSC_LINK, CSC_KEY_PASSWORD')
  })

  it('exits with the build exit code so a failed build fails the job', () => {
    const result = run(['dist:linux'], { FAKE_NPM_EXIT: '7' })
    expect(result.status, `stderr: ${result.stderr}`).toBe(7)
  })

  it('refuses anything but a dist:* script with exit 2 and the usage', () => {
    const result = run(['dist:mac; echo pwned'], {})
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: node scripts/release-build.ts <dist:win|dist:mac|dist:linux>')
  })
})
