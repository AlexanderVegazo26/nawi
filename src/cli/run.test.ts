import { describe, expect, it } from 'vitest'
import { MAX_FLOW_FILE_BYTES, flowReferences, inputsFor, parseRunArgs, readFlowText, renderRun, runExitCode, RunUsageError, type RunReport } from './run'

describe('nawi run: arguments', () => {
  it('resolves a relative flow file against the shell cwd and collects repeated --var', () => {
    const args = parseRunArgs(['flows/login.nawi.yaml', '--var', 'email=a@b.example', '--var', 'q=a=b', '--headless'], '/home/u/proj')
    expect(args).toEqual({
      file: '/home/u/proj/flows/login.nawi.yaml',
      vars: { email: 'a@b.example', q: 'a=b' },
      headless: true,
      json: false
    })
  })

  it('takes --cdp-endpoint, --step-timeout-ms and --json, and leaves an absolute file as is', () => {
    expect(parseRunArgs(['--json', '/f.nawi.yaml', '--cdp-endpoint', '9222', '--step-timeout-ms', '800'], '/x')).toEqual({
      file: '/f.nawi.yaml',
      vars: {},
      headless: false,
      json: true,
      cdp_endpoint: '9222',
      step_timeout_ms: 800
    })
  })

  it('takes --screenshots all, failed or off', () => {
    for (const mode of ['all', 'failed', 'off'] as const) {
      expect(parseRunArgs(['/f.nawi.yaml', '--screenshots', mode], '/x').screenshots, `--screenshots ${mode}`).toBe(mode)
    }
    expect(parseRunArgs(['/f.nawi.yaml'], '/x').screenshots, 'unset: the app decides').toBeUndefined()
  })

  it('takes --trace, sent as run_flow\'s trace, and leaves it out when not given', () => {
    expect(parseRunArgs(['/f.nawi.yaml', '--trace'], '/x').trace, '--trace').toBe(true)
    expect('trace' in parseRunArgs(['/f.nawi.yaml'], '/x'), 'unset: the app default (off)').toBe(false)
  })

  it('takes --target and --no-launch for android flows, sent as run_flow\'s target and launch', () => {
    expect(parseRunArgs(['/phone.nawi.yaml', '--target', 'emulator-5560', '--no-launch'], '/x')).toEqual({
      file: '/phone.nawi.yaml',
      vars: {},
      headless: false,
      json: false,
      target: 'emulator-5560',
      launch: false
    })
    expect(parseRunArgs(['/phone.nawi.yaml'], '/x').launch, 'unset: the app restarts the app (its default)').toBeUndefined()
  })

  it('resolves --junit against the shell\'s cwd', () => {
    expect(parseRunArgs(['/f.nawi.yaml', '--junit', 'out/report.xml'], '/home/u/proj').junit).toBe('/home/u/proj/out/report.xml')
  })

  it.each([
    [[], 'run needs a flow file.'],
    [['a.nawi.yaml', 'b.nawi.yaml'], 'run takes one flow file'],
    [['a.nawi.yaml', '--var'], '--var needs a value.'],
    [['a.nawi.yaml', '--var', 'novalue'], '--var takes name=value'],
    [['a.nawi.yaml', '--var', '=x'], '--var takes name=value'],
    [['a.nawi.yaml', '--step-timeout-ms', '-5'], '--step-timeout-ms takes a whole number from 100 to 600000'],
    [['a.nawi.yaml', '--step-timeout-ms', '50'], '--step-timeout-ms takes a whole number from 100 to 600000'],
    [['a.nawi.yaml', '--step-timeout-ms', '600001'], '--step-timeout-ms takes a whole number from 100 to 600000'],
    [['a.nawi.yaml', '--cdp-endpoint', '--headless'], '--cdp-endpoint needs a value.'],
    [['a.nawi.yaml', '--frobnicate'], 'Unknown flag "--frobnicate"'],
    [['a.nawi.yaml', '--junit', './a.nawi.yaml'], '--junit must name a report file, not the flow file.'],
    [['a.nawi.yaml', '--screenshots', 'some'], '--screenshots takes all, failed or off, got "some".'],
    [['a.nawi.yaml', '--screenshots'], '--screenshots needs a value.'],
    [['a.nawi.yaml', '--target'], '--target needs a value.'],
    [['a.nawi.yaml', '--target', '--no-launch'], '--target needs a value.']
  ])('rejects %j as a usage error', (argv, message) => {
    expect(() => parseRunArgs(argv, '/x'), `argv ${JSON.stringify(argv)}`).toThrow(RunUsageError)
    expect(() => parseRunArgs(argv, '/x')).toThrow(message)
  })
})

describe('nawi run: env and secrets sent to the app', () => {
  const text = `vars: { email: "\${env.TEST_EMAIL}" }
steps:
  - { id: s1, action: fill, value: "\${secret.app_pw}" }
  - { id: s2, action: fill, value: "\${env.TEST_EMAIL} \${env.MISSING} \${vars.email}" }`

  it('finds each env and secret name the flow refers to, once', () => {
    expect(flowReferences(text)).toEqual({ env: ['TEST_EMAIL', 'MISSING'], secret: ['app_pw'] })
  })

  it('sends only the referenced names this shell has, never the rest of the environment', () => {
    const shell = { TEST_EMAIL: 'a@b.example', HOME: '/home/u', AWS_SECRET_ACCESS_KEY: 'nope', NAWI_SECRET_APP_PW: 'pw1' }
    const sent = inputsFor(flowReferences(text), shell)
    expect(sent).toEqual({ env: { TEST_EMAIL: 'a@b.example' }, secrets: { app_pw: 'pw1' } })
    expect(JSON.stringify(sent), 'unreferenced variables must not leave the shell').not.toContain('nope')
  })

  it('finds references written with spaces inside the braces, as the app accepts them', () => {
    expect(flowReferences('url: "${ env.BASE_URL }/login" pw: "${secret.pw }"')).toEqual({ env: ['BASE_URL'], secret: ['pw'] })
  })

  it('ignores whole-line comments, so a commented-out step does not pull a value from the shell', () => {
    expect(flowReferences('steps:\n  # - { value: "${env.AWS_SECRET_ACCESS_KEY}" }\n  - { value: "${env.USED}" }')).toEqual({ env: ['USED'], secret: [] })
  })

  it('also finds references inside --var values', () => {
    expect(flowReferences('vars: { password: x }', ['${secret.pw}', 'plain'])).toEqual({ env: [], secret: ['pw'] })
  })

  it('prefers NAWI_SECRET_<name> exactly as written over the upper-cased form', () => {
    expect(inputsFor({ env: [], secret: ['pw'] }, { NAWI_SECRET_pw: 'exact', NAWI_SECRET_PW: 'upper' }).secrets).toEqual({ pw: 'exact' })
  })
})

describe('nawi run: reading the flow file in the CLI', () => {
  const fs = (stat: { isFile(): boolean; size: number } | Error, text = 'steps: []') => {
    const reads: string[] = []
    return {
      reads,
      statSync: () => {
        if (stat instanceof Error) throw stat
        return stat
      },
      readFileSync: (p: string) => (reads.push(p), text)
    }
  }

  it('reads a regular *.nawi.yaml file within the size limit', () => {
    const f = fs({ isFile: () => true, size: 10 })
    expect(readFlowText('/h/a.nawi.yaml', f)).toBe('steps: []')
  })

  it.each([
    ['another extension', '/dev/zero', { isFile: () => true, size: 0 }],
    ['a device or directory', '/h/d.nawi.yaml', { isFile: () => false, size: 0 }],
    ['an oversized file', '/h/big.nawi.yaml', { isFile: () => true, size: MAX_FLOW_FILE_BYTES + 1 }],
    ['a missing file', '/h/none.nawi.yaml', new Error('ENOENT')]
  ])('does not read %s (the app refuses it with the reason)', (_label, file, stat) => {
    const f = fs(stat)
    expect(readFlowText(file, f)).toBeNull()
    expect(f.reads, `${file} must not be read`).toEqual([])
  })
})

describe('nawi run: output and exit code', () => {
  const failed: RunReport = {
    flow: 'Sign in',
    status: 'failed',
    duration_ms: 1234,
    steps: [
      { id: 's1', action: 'fill', status: 'passed', durationMs: 40 },
      { id: 's2', action: 'click', status: 'failed', durationMs: 5000, error: 'no locator matched exactly one element within 5000 ms' },
      { id: 's3', action: 'assert', status: 'not_run' },
      { id: 's4', action: 'wait', status: 'skipped' }
    ]
  }

  it('names the device of an android run under the flow name, and whether the app was restarted', () => {
    const avd = renderRun({ ...failed, device: { kind: 'avd', name: 'loop-api36', api: 36, launched_activity: '.MainActivity' } }).split('\n')
    expect(avd.slice(0, 2), 'virtual device, API level and the activity started').toEqual(['Sign in', '  on virtual device loop-api36, API 36, started .MainActivity'])
    const phone = renderRun({ ...failed, device: { kind: 'device', name: 'R5CT1234', api: null } }).split('\n')
    expect(phone[1], 'a phone by serial; no API when unknown; launch off').toBe('  on R5CT1234, app as it was')
    expect(renderRun(failed).split('\n')[1], 'browser runs have no device line').toMatch(/^  FAIL|^  ok/)
  })

  it('prints one line per step with the failure reason and a summary', () => {
    expect(renderRun(failed)).toBe(
      [
        'Sign in',
        '  ok   s1 fill (40 ms)',
        '  FAIL s2 click (5000 ms)',
        '       no locator matched exactly one element within 5000 ms',
        '  --   s3 assert',
        '  skip s4 wait',
        'FAILED: 1 passed, 1 failed, 1 not run, 1 skipped in 1234 ms'
      ].join('\n')
    )
  })

  it('warns under a passing step that was found only by a fallback locator (AI1 drift), and not otherwise', () => {
    const out = renderRun({
      flow: 'Save',
      status: 'passed',
      duration_ms: 50,
      steps: [
        { id: 's1', action: 'click', status: 'passed', durationMs: 20, matched: { index: 0, selector: { testid: 'a' }, layer: 'testid', fallback: false } },
        { id: 's2', action: 'click', status: 'passed', durationMs: 30, matched: { index: 2, selector: { text: 'Save' }, layer: 'text', fallback: true } }
      ]
    })
    expect(out).toBe(
      [
        'Save',
        '  ok   s1 click (20 ms)',
        '  ok   s2 click (30 ms)',
        '       fallback: found by locator 2 (text); a more stable locator found nothing, update the flow',
        'PASSED: 2 passed, 0 failed, 0 not run, 0 skipped in 50 ms'
      ].join('\n')
    )
  })

  it('prints up to three console errors and failed requests under a step, then how many more', () => {
    const out = renderRun({
      flow: 'Save',
      status: 'passed',
      duration_ms: 10,
      opening: { failedRequests: [{ method: 'GET', url: 'https://app.example/missing.css', status: 404 }] },
      steps: [
        {
          id: 's1',
          action: 'click',
          status: 'passed',
          durationMs: 10,
          consoleErrors: [1, 2, 3, 4].map((i) => ({ source: 'console', message: `error ${i}\n  at line ${i}` })),
          consoleErrorsDropped: 6,
          failedRequests: [{ method: 'POST', url: 'https://app.example/api', error: 'net::ERR_CONNECTION_REFUSED' }]
        }
      ]
    })
    expect(out).toBe(
      [
        'Save',
        '  while opening the target:',
        '       request GET https://app.example/missing.css: HTTP 404',
        '  ok   s1 click (10 ms)',
        '       console console: error 1 at line 1',
        '       console console: error 2 at line 2',
        '       console console: error 3 at line 3',
        '       … 7 more console errors',
        '       request POST https://app.example/api: net::ERR_CONNECTION_REFUSED',
        'PASSED: 1 passed, 0 failed, 0 not run, 0 skipped in 10 ms'
      ].join('\n')
    )
  })

  it('prints up to three device log lines under an android step, then how many more', () => {
    const log = (i: number) => ({ level: 'E', tag: 'Shop', message: `boom ${i}\n  at Main.kt:${i}` })
    const out = renderRun({ flow: 'Shop', status: 'passed', duration_ms: 10, steps: [{ id: 's1', action: 'click', status: 'passed', durationMs: 10, logcat: [1, 2, 3, 4].map(log), logcatDropped: 2 }] })
    expect(out).toContain(
      ['  ok   s1 click (10 ms)', '       logcat E Shop: boom 1 at Main.kt:1', '       logcat E Shop: boom 2 at Main.kt:2', '       logcat E Shop: boom 3 at Main.kt:3', '       … 3 more device log lines'].join('\n')
    )
  })

  it('prints a run-level error (missing inputs, kill switch) before the summary', () => {
    const out = renderRun({ ...failed, error: 'the flow needs a value the run did not provide: ${env.X}', steps: [] })
    expect(out).toContain('error: the flow needs a value the run did not provide: ${env.X}\nFAILED: 0 passed')
  })

  it('names the run record folder, or why it was not saved, after the summary', () => {
    expect(renderRun({ ...failed, run_dir: '/u/.config/nawi/runs/20261102T000000000Z-abc123' })).toMatch(
      /FAILED: .* ms\nrecord: \/u\/\.config\/nawi\/runs\/20261102T000000000Z-abc123$/
    )
    expect(renderRun({ ...failed, record_error: 'ENOSPC: no space left' })).toMatch(/\nrecord not saved: ENOSPC: no space left$/)
  })

  it('prints the trace as a path inside the run folder, or why there is none', () => {
    const dir = '/u/.config/nawi/runs/20261102T000000000Z-abc123'
    expect(renderRun({ ...failed, run_dir: dir, trace_json: 'trace.json' })).toMatch(new RegExp(`\\nrecord: ${dir}\\ntrace: ${dir}/trace\\.json$`))
    expect(renderRun({ ...failed, trace_json: 'trace.json' }), 'no path without a saved record').not.toContain('trace:')
    expect(renderRun({ ...failed, trace_error: 'the browser would not start a trace:\n  busy' })).toMatch(
      /\nno trace: the browser would not start a trace: busy$/
    )
  })

  it("prints the failing step's screenshot as a path inside the run folder", () => {
    const shots = {
      ...failed,
      run_dir: '/u/runs/20261102T000000000Z-abc123',
      steps: failed.steps.map((st) =>
        st.id === 's1'
          ? { ...st, shots: { before: 'steps/001-s1.before.jpg', after: 'steps/001-s1.after.jpg' } }
          : st.id === 's2'
            ? { ...st, shots: { before: 'steps/001-s1.after.jpg', after: 'steps/002-s2.after.jpg' } }
            : st
      )
    }
    const lines = renderRun(shots).split('\n')
    expect(lines.slice(2, 6)).toEqual([
      '  FAIL s2 click (5000 ms)',
      '       no locator matched exactly one element within 5000 ms',
      '       screenshot: /u/runs/20261102T000000000Z-abc123/steps/002-s2.after.jpg',
      '  --   s3 assert'
    ])
    expect(lines.filter((l) => l.includes('screenshot:')), 'only for the failed step').toHaveLength(1)
    expect(renderRun({ ...shots, run_dir: undefined }), 'no path without a saved record').not.toContain('screenshot:')
  })

  it('exits 0 only when the run passed', () => {
    expect(runExitCode({ status: 'passed' })).toBe(0)
    expect(runExitCode({ status: 'failed' })).toBe(1)
  })
})
