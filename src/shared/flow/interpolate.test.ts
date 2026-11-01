import { describe, expect, it } from 'vitest'
import { FlowSchema, type Flow, type FlowStep } from './schema'
import { createInterpolator, interpolatedStrings, MissingFlowInputsError } from './interpolate'

function flow(steps: FlowStep[], vars?: Record<string, string>, url = 'https://app.example/${env.PATH_PART}'): Flow {
  return FlowSchema.parse({ version: 1, name: 't', target: { kind: 'browser', url }, ...(vars ? { vars } : {}), steps })
}

const fill = (id: string, value: string, disabled?: boolean): FlowStep => ({
  id,
  action: 'fill',
  target: { selectors: [{ id: 'x' }] },
  value,
  ...(disabled ? { disabled } : {})
})

describe('createInterpolator', () => {
  it('resolves vars (through env and secret), env and secret placeholders', () => {
    const f = flow([fill('a', '${vars.login} / ${secret.pw} / ${env.HOST}')], { login: 'user@${env.DOMAIN}' })
    const i = createInterpolator(f, {
      env: { PATH_PART: 'login', DOMAIN: 'corp.example', HOST: 'h1' },
      secret: (n) => (n === 'pw' ? 's3cret' : undefined)
    })
    expect(i.interpolate('${vars.login} / ${secret.pw} / ${env.HOST}')).toBe('user@corp.example / s3cret / h1')
    expect(i.interpolate(f.target.kind === 'browser' ? f.target.url : '')).toBe('https://app.example/login')
  })

  it('names every missing env var and secret up front, sorted, before anything runs', () => {
    const f = flow([fill('a', '${secret.pw}'), fill('b', '${vars.v}')], { v: '${env.B_VAR}' })
    let error: unknown
    try {
      createInterpolator(f, { env: {} })
    } catch (e) {
      error = e
    }
    expect(error, 'missing inputs should throw MissingFlowInputsError').toBeInstanceOf(MissingFlowInputsError)
    expect((error as MissingFlowInputsError).missing).toEqual(['env.B_VAR', 'env.PATH_PART', 'secret.pw'])
    expect((error as Error).message).toBe(
      'the flow needs values the run did not provide: ${env.B_VAR}, ${env.PATH_PART}, ${secret.pw}'
    )
  })

  it('does not require inputs that only disabled steps use', () => {
    const f = flow([fill('a', '${secret.only_here}', true)])
    expect(() => createInterpolator(f, { env: { PATH_PART: 'p' } })).not.toThrow()
    expect(interpolatedStrings(f)).toEqual(['https://app.example/${env.PATH_PART}'])
  })

  it('does not read inherited properties as env values (env.constructor is missing, not a function)', () => {
    const f = flow([fill('a', '${env.constructor}')])
    expect(() => createInterpolator(f, { env: { PATH_PART: 'p' } })).toThrow('${env.constructor}')
  })

  it('treats an empty string as a provided value', () => {
    const f = flow([fill('a', '[${env.EMPTY}]')])
    expect(createInterpolator(f, { env: { PATH_PART: 'p', EMPTY: '' } }).interpolate('[${env.EMPTY}]')).toBe('[]')
  })

  it('keeps "$&" and "$1" in values literally (no replacement patterns)', () => {
    const f = flow([fill('a', '${env.ODD}')])
    expect(createInterpolator(f, { env: { PATH_PART: 'p', ODD: 'a$&b$1' } }).interpolate('${env.ODD}')).toBe('a$&b$1')
  })

  it('redacts every secret value it resolved, longest first, including inside vars', () => {
    const f = flow([fill('a', '${secret.long} ${secret.short} ${vars.v}')], { v: 'x-${secret.inner}' })
    const values: Record<string, string> = { long: 'abc123', short: 'abc', inner: 'zzz' }
    const i = createInterpolator(f, { env: { PATH_PART: 'p' }, secret: (n) => values[n] })
    expect(i.redact('got abc123 then abc then x-zzz')).toBe('got ${secret.long} then ${secret.short} then x-${secret.inner}')
  })

  it('does not need target.url inputs when the run will not open the target', () => {
    const f = flow([fill('a', 'x')])
    expect(() => createInterpolator(f, { env: {} })).toThrow('${env.PATH_PART}')
    expect(() => createInterpolator(f, { env: {} }, { includeTarget: false })).not.toThrow()
  })

  it('redacts a secret in its URL-encoded forms too', () => {
    const f = flow([fill('a', '${secret.pw}')])
    const i = createInterpolator(f, { env: { PATH_PART: 'p' }, secret: () => 'a b&c/d' })
    expect(i.redact('?t=a%20b%26c%2Fd&u=a+b%26c%2Fd&v=a%20b&c/d')).toBe('?t=${secret.pw}&u=${secret.pw}&v=${secret.pw}')
  })

  it('redacts a secret whose whitespace the page folded or trimmed, and treats regex characters literally', () => {
    const f = flow([fill('a', '${secret.pw}')])
    const i = createInterpolator(f, { env: { PATH_PART: 'p' }, secret: () => ' a.b  c*(d) ' })
    expect(i.redact('[a.b c*(d)] [a.b\n\tc*(d)] [axb c*(d)]')).toBe('[${secret.pw}] [${secret.pw}] [axb c*(d)]')
  })

  it('asks the secret store once per name', () => {
    const f = flow([fill('a', '${secret.pw}'), fill('b', '${secret.pw}')])
    const asked: string[] = []
    const i = createInterpolator(f, { env: { PATH_PART: 'p' }, secret: (n) => (asked.push(n), 'v') })
    i.interpolate('${secret.pw}')
    expect(asked).toEqual(['pw'])
  })
})
