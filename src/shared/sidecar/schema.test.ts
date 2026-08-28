import { describe, expect, it } from 'vitest'
import { parseSidecar, parseSidecarStrict, SidecarLoose, SidecarStrict } from './schema'
import { checkCompatibility, isReadable, parseSchemaVersion, SCHEMA_VERSION } from './version'
import { validSidecar } from './__fixtures__/sidecar'

describe('DC-4 — schema round-trip', () => {
  it('accepts a complete sidecar on both parsers and survives JSON round-trip unchanged', () => {
    const sidecar = validSidecar()

    expect(SidecarStrict.safeParse(sidecar).success).toBe(true)
    expect(SidecarLoose.safeParse(sidecar).success).toBe(true)

    const roundTripped: unknown = JSON.parse(JSON.stringify(sidecar))
    const parsed = parseSidecarStrict(roundTripped)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(sidecar)
  })

  it('rejects a malformed field with a readable error rather than coercing it', () => {
    const bad = validSidecar({ duration_ms: 'twelve' as unknown as number })
    const result = parseSidecarStrict(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('duration_ms')
  })

  it('FR-STA.6 — rejects a selector stability outside [0,1]', () => {
    const sidecar = validSidecar()
    const withEvents = {
      ...sidecar,
      state_layer: {
        ...sidecar.state_layer,
        input_events: [
          {
            t_ms: 1,
            type: 'click',
            coordinates: { x: 1, y: 2 },
            target: {
              role: 'button',
              accessible_name: 'Save',
              text: 'Save',
              bounds: [1, 2, 3, 4],
              selectors: [{ strategy: 'testid', value: '[data-testid="save"]', stability: 1.5 }]
            },
            value_redacted: false
          }
        ]
      }
    }
    expect(SidecarLoose.safeParse(withEvents).success).toBe(false)
  })
})

describe('DC-6 — unknown fields are preserved, not stripped', () => {
  /**
   * The failure this guards against is silent: zod's default object behaviour
   * *strips* unknown keys, so a reader on an older build would quietly delete a
   * field a newer writer added the moment it round-tripped the file. Planting the
   * key at the root only would not catch it — stripping happens per level.
   */
  const planted = () => {
    const base = validSidecar()
    return {
      ...base,
      future_root_field: { anything: true },
      surface: { ...base.surface, future_surface_field: 'kept' },
      state_layer: {
        ...base.state_layer,
        future_state_field: [1, 2, 3],
        unavailable: [{ source: 'dom_snapshot', reason: 'unsupported_surface', future_entry_field: 7 }]
      }
    }
  }

  it('parses a sidecar carrying unknown fields at the root, nested, and inside an array entry', () => {
    const result = SidecarLoose.safeParse(planted())
    expect(result.success).toBe(true)
  })

  it('returns every unknown field intact — root, nested and array-entry', () => {
    const input = planted()
    const result = parseSidecar(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const value = result.value as unknown as Record<string, any>
    expect(value.future_root_field).toEqual({ anything: true })
    expect(value.surface.future_surface_field).toBe('kept')
    expect(value.state_layer.future_state_field).toEqual([1, 2, 3])
    expect(value.state_layer.unavailable[0].future_entry_field).toBe(7)

    // And re-serializing must not lose them either — the round trip is the real
    // risk, not the parse.
    expect(JSON.parse(JSON.stringify(value))).toEqual(input)
  })

  it('the write parser rejects the same unknown fields', () => {
    // Strict on the way out is what keeps *our* writer from inventing fields;
    // loose on the way in is what keeps us from destroying someone else's.
    expect(SidecarStrict.safeParse(planted()).success).toBe(false)
  })

  it('accepts an externally-authored sidecar with DC-4 inline console/input arrays (ADR-001)', () => {
    const base = validSidecar()
    const external = {
      ...base,
      state_layer: {
        ...base.state_layer,
        console_log: [{ t_ms: 4120, level: 'error', message: 'boom', stack: null }],
        input_events: [
          {
            t_ms: 5310,
            type: 'click',
            coordinates: { x: 402, y: 611 },
            target: {
              role: 'button',
              accessible_name: 'Save changes',
              text: 'Save',
              bounds: [380, 596, 120, 36],
              selectors: [{ strategy: 'testid', value: '[data-testid="save"]', stability: 0.95 }]
            },
            value_redacted: false
          }
        ]
      }
    }

    const result = parseSidecar(external)
    expect(result.ok).toBe(true)
    if (result.ok) expect(Array.isArray(result.value.state_layer.console_log)).toBe(true)

    // Our own writer may not produce that shape — one form on disk, ours.
    expect(SidecarStrict.safeParse(external).success).toBe(false)
  })
})

describe('DC-6 — semver compatibility', () => {
  it('parses major.minor and tolerates a patch segment', () => {
    expect(parseSchemaVersion('1.0')).toEqual({ major: 1, minor: 0 })
    expect(parseSchemaVersion('1.4.2')).toEqual({ major: 1, minor: 4 })
    expect(parseSchemaVersion('v1.0')).toBeNull()
    expect(parseSchemaVersion(1 as unknown)).toBeNull()
  })

  it('treats a higher minor as readable (additive) and a different major as not', () => {
    expect(checkCompatibility('1.0').status).toBe('compatible')
    expect(checkCompatibility('1.7').status).toBe('forward_compatible')
    expect(checkCompatibility('2.0').status).toBe('incompatible')
    expect(checkCompatibility('nonsense').status).toBe('unparseable')

    expect(isReadable('1.7')).toBe(true)
    expect(isReadable('2.0')).toBe(false)
  })

  it('this build writes 1.0', () => {
    expect(SCHEMA_VERSION).toBe('1.0')
    expect(validSidecar().schema_version).toBe('1.0')
  })
})
