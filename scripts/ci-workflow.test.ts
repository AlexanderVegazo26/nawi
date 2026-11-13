import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * Contract for ci.yml's E2E job. e2e/serve.spec.ts spawns the real `nawi serve`, which keeps Chromium's sandbox on;
 * on the Ubuntu runner (no unprivileged user namespaces) that needs the setuid helper owned by root with mode 4755,
 * or the app aborts before printing its ready line (weekly run 2026-11-09 and dispatch 2026-11-13: "exited 1").
 */

interface Step {
  name?: string
  if?: string
  run?: string
  uses?: string
}

const root = path.resolve(import.meta.dirname, '..')
const workflow = parse(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: { e2e: { steps: Step[] } }
}
const steps = workflow.jobs.e2e.steps
const HELPER = 'node_modules/electron/dist/chrome-sandbox'

const indexOf = (pred: (s: Step) => boolean): number => steps.findIndex(pred)

describe('ci.yml E2E job', () => {
  const setup = indexOf((s) => (s.run ?? '').includes(HELPER))
  const step = steps[setup]

  it('makes the chrome-sandbox helper root-owned and setuid on Linux, so `nawi serve` starts sandboxed', () => {
    expect(setup, `no e2e step touches ${HELPER}; serve.spec.ts dies on "SUID sandbox helper ... not configured"`).not.toBe(-1)
    expect(step?.if, 'the helper setup is Linux-only (sudo/chown do not exist on the Windows runner)').toBe("runner.os == 'Linux'")
    expect(step?.run, 'helper must be owned by root').toContain(`sudo chown root:root ${HELPER}`)
    expect(step?.run, 'helper must be setuid (4755)').toContain(`sudo chmod 4755 ${HELPER}`)
  })

  it('sets the helper up after Electron is installed and before the Linux E2E suite runs', () => {
    const install = indexOf((s) => s.run === 'npm run install-electron')
    const linuxSuite = indexOf((s) => s.if === "runner.os == 'Linux'" && (s.run ?? '').includes('npm run test:e2e'))
    expect(install, 'e2e job has no `npm run install-electron` step').not.toBe(-1)
    expect(linuxSuite, 'e2e job has no Linux `npm run test:e2e` step').not.toBe(-1)
    expect(
      install < setup && setup < linuxSuite,
      `step order must be install-electron < helper setup < Linux E2E (the helper only exists after install-electron); ` +
        `got install-electron #${install}, helper setup #${setup}, Linux E2E #${linuxSuite}`
    ).toBe(true)
  })

  it('never disables the sandbox to get serve.spec.ts through', () => {
    const disabling = steps.filter((s) => /--no-sandbox|ELECTRON_DISABLE_SANDBOX/.test(s.run ?? ''))
    expect(disabling.map((s) => s.name ?? s.run), 'fix the helper instead of turning the sandbox off').toEqual([])
  })
})
