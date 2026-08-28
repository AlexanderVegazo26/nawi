/**
 * FR-SEC.2 / DC-3 — the redaction chokepoint.
 *
 * Two tiers, and they are not alternatives:
 *
 *  - **Tier A — the requirement.** Ingest-time suppression. `inject/probe.js`
 *    never puts a secret field's value into a message, and `harvest.ts` filters
 *    the DOM snapshot by the secret `backendNodeId` set and strips
 *    `Authorization`/`Cookie`/`Set-Cookie` while the HAR entry is being built.
 *    Nothing in this file is a substitute for any of that.
 *  - **Tier B — the assurance.** `seal()` re-reads every string that is about to
 *    reach disk and matches it against the FR-AI.3 pattern set. It exists to
 *    catch the case where Tier A leaked.
 *
 * **A Tier-B hit on a value Tier A claimed to have suppressed is a FAILURE, not
 * a success.** It is reported separately as `report.tierAFailures`, because a
 * test cannot tell the two apart from the redaction count alone: a Tier-B hit on
 * ordinary page text (an email in visible DOM content) is Tier B doing its job,
 * while a hit on a known password sentinel means the layer that was supposed to
 * stop it did not. The discriminator is provenance, so `harvest.ts` hands the
 * suppressed values in via `policy.suppressedValues` — without that input the
 * distinction is not constructible.
 *
 * **The type system is the enforcement, on the path that uses it.**
 * `SealedSidecar` carries a branding symbol no other module can name, so it is
 * constructible only here, and `writer.ts` accepts only a `SealedRevision`. That
 * much is genuinely compile-time. It is *not* true that unsealed data cannot
 * reach a capture directory by any route — `library.ts`'s `saveSidecarRevision`
 * is a second, unbranded door. `writer.ts`'s header documents that seam exactly,
 * including why closing it needs a binary-content policy here first. Read it
 * before relying on the brand as a whole-system property.
 */

import { finalize, type SidecarDraft } from '@shared/sidecar/draft'
import type { Redaction, RedactionTarget, Sidecar } from '@shared/sidecar/types'
import type { RedactionRule } from '@shared/settings'
import type { RevisionFile } from './store'

/* ------------------------------------------------------------------ *
 * The brand
 * ------------------------------------------------------------------ */

declare const sealed: unique symbol

/**
 * A sidecar that has been through Tier B. Not constructible outside this
 * module: nothing else can produce the `[sealed]` property, because nothing
 * else can name the symbol.
 */
export type SealedSidecar = Sidecar & { readonly [sealed]: true }

/**
 * Everything one revision writes. The brand lives on the sidecar, and the files
 * ride along inside the same container, so a caller cannot pair a sealed
 * sidecar with unscanned side files — which matters enormously, because the
 * password lives in `dom/000000.json` and `network.har`, not in the root JSON.
 */
export interface SealedRevision {
  readonly sidecar: SealedSidecar
  readonly files: readonly RevisionFile[]
  readonly report: SealReport
}

/* ------------------------------------------------------------------ *
 * Pattern set — FR-AI.3's enumerated classes
 * ------------------------------------------------------------------ */

export type PatternId =
  | 'private_key'
  | 'jwt'
  | 'authorization'
  | 'api_key'
  | 'card_number'
  | 'national_id'
  | 'email'
  | 'phone'

export interface SealPattern {
  id: PatternId
  label: string
  /** Fresh instance per scan: a shared `g` regex carries `lastIndex` between calls. */
  make: () => RegExp
  /** Optional second gate, to keep the false-positive rate sane (Luhn, mostly). */
  accept?: (match: string) => boolean
}

/** Luhn check digit. Card numbers without it produce an unusable false-positive rate. */
export function luhnValid(digits: string): boolean {
  const clean = digits.replace(/[^0-9]/g, '')
  if (clean.length < 13 || clean.length > 19) return false
  let sum = 0
  let double = false
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Ordered most-specific-first. A JWT would otherwise be eaten by the generic
 * API-key pattern and reported under the wrong class, and a PEM block would be
 * shredded into a dozen base64 fragments instead of one redaction.
 */
export const SEAL_PATTERNS: readonly SealPattern[] = Object.freeze([
  {
    id: 'private_key',
    label: 'Private key block',
    make: () =>
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g
  },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    // Three base64url segments; the header segment must decode to something
    // starting `{"` so ordinary dotted identifiers are not swept up.
    make: () => /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g
  },
  {
    id: 'authorization',
    label: 'Authorization header value',
    make: () => /\b(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9+/=._~-]{8,}/gi
  },
  {
    id: 'api_key',
    label: 'API key or token',
    make: () =>
      /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g
  },
  {
    id: 'card_number',
    label: 'Payment card number',
    make: () => /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: luhnValid
  },
  {
    id: 'national_id',
    label: 'National ID number',
    // US SSN shape, with the administratively-invalid ranges excluded so dates
    // and version strings do not read as identity numbers.
    make: () => /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g
  },
  {
    id: 'email',
    label: 'Email address',
    make: () => /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },
  {
    id: 'phone',
    label: 'Phone number',
    make: () => /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b/g
  }
])

/** What replaces a match. Deliberately unmistakable in a byte scan. */
export function sentinelFor(id: string): string {
  return `[REDACTED:${id}]`
}

/** The value a suppressed secret is replaced with when Tier A leaked one through. */
export const TIER_A_LEAK_SENTINEL = '[REDACTED:tier-a-leak]'

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

export interface SealPolicy {
  /**
   * Workspace rules from `settings.redactionRules`. **Additive only** — they
   * extend the built-in set and can never disable it. Tier B is the assurance
   * layer, so making it configurable would make the assurance configurable.
   */
  rules?: readonly RedactionRule[]
  /**
   * Values Tier A suppressed at ingest. Finding one of these downstream means
   * Tier A leaked; they are matched literally and reported as
   * `tierAFailures`, never as an ordinary redaction.
   */
  suppressedValues?: readonly string[]
}

export interface SealHit {
  patternId: string
  label: string
  /** Where it was found: `sidecar`, or a revision-relative file path. */
  site: string
  count: number
}

export interface TierAFailure {
  /** Never the value itself — that would move the secret into the report. */
  valueLength: number
  valuePreview: string
  site: string
  count: number
}

export interface SealReport {
  hits: SealHit[]
  /** Non-empty means Tier A leaked. A test asserts this is empty. */
  tierAFailures: TierAFailure[]
  filesScanned: number
  bytesScanned: number
  /** Rules from settings that would not compile. Reported, never silently dropped. */
  invalidRules: Array<{ id: string; error: string }>
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

interface CompiledPattern {
  id: string
  label: string
  make: () => RegExp
  accept?: (match: string) => boolean
}

/**
 * Built-ins plus whatever of the workspace rules actually compiles.
 *
 * A malformed user regex must not disable the rest of the policy — the same
 * rule `probe.js` applies to a bad configured selector — so each is compiled in
 * isolation and a failure is surfaced in the report rather than thrown.
 */
function compilePatterns(policy: SealPolicy): {
  patterns: CompiledPattern[]
  invalidRules: Array<{ id: string; error: string }>
} {
  const patterns: CompiledPattern[] = SEAL_PATTERNS.map((p) => ({
    id: p.id,
    label: p.label,
    make: p.make,
    ...(p.accept ? { accept: p.accept } : {})
  }))
  const invalidRules: Array<{ id: string; error: string }> = []

  for (const rule of policy.rules ?? []) {
    if (!rule.enabled) continue
    try {
      // Compile once here to surface a syntax error, then re-make per scan so
      // no `lastIndex` is shared between call sites.
      // eslint-disable-next-line no-new
      new RegExp(rule.pattern, 'g')
      patterns.push({
        id: rule.id,
        label: rule.label,
        make: () => new RegExp(rule.pattern, 'g')
      })
    } catch (err) {
      invalidRules.push({ id: rule.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { patterns, invalidRules }
}

/** A short, non-reversible-enough marker so a report can name *which* secret leaked. */
function preview(value: string): string {
  return `${value.slice(0, 2)}…${value.slice(-2)} (${value.length} chars)`
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface ScanAccumulator {
  hits: Map<string, { label: string; count: number }>
  tierA: Map<string, { valueLength: number; valuePreview: string; count: number }>
}

/**
 * Redact one string.
 *
 * Suppressed values go first and are matched literally: a leaked password that
 * also happens to look like an API key must be classified as a Tier A failure,
 * not filed away as a routine redaction.
 */
function redactString(
  text: string,
  patterns: readonly CompiledPattern[],
  suppressed: readonly string[],
  acc: ScanAccumulator
): string {
  if (text.length === 0) return text
  let out = text

  for (const value of suppressed) {
    if (value.length < 4 || !out.includes(value)) continue
    let count = 0
    out = out.replace(new RegExp(escapeLiteral(value), 'g'), () => {
      count++
      return TIER_A_LEAK_SENTINEL
    })
    if (count > 0) {
      const existing = acc.tierA.get(value)
      if (existing) existing.count += count
      else
        acc.tierA.set(value, {
          valueLength: value.length,
          valuePreview: preview(value),
          count
        })
    }
  }

  for (const pattern of patterns) {
    const re = pattern.make()
    let count = 0
    out = out.replace(re, (match) => {
      if (pattern.accept && !pattern.accept(match)) return match
      count++
      return sentinelFor(pattern.id)
    })
    if (count > 0) {
      const existing = acc.hits.get(pattern.id)
      if (existing) existing.count += count
      else acc.hits.set(pattern.id, { label: pattern.label, count })
    }
  }
  return out
}

/**
 * Structural keys whose values are identifiers, not content.
 *
 * A `capture_id` is a UUID and a `path` is `dom/000000.json`; running the
 * pattern set over them risks mangling the very fields the store uses to find
 * files, for no privacy gain. Everything else is scanned.
 */
const STRUCTURAL_KEYS = new Set([
  'schema_version',
  'capture_id',
  'created_at',
  'path',
  'sha256',
  'supersedes',
  'strategy',
  'generator',
  'applied_to',
  'kind'
])

function redactDeep(
  value: unknown,
  patterns: readonly CompiledPattern[],
  suppressed: readonly string[],
  acc: ScanAccumulator
): unknown {
  if (typeof value === 'string') return redactString(value, patterns, suppressed, acc)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, patterns, suppressed, acc))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = STRUCTURAL_KEYS.has(key)
        ? child
        : redactDeep(child, patterns, suppressed, acc)
    }
    return out
  }
  return value
}

/* ------------------------------------------------------------------ *
 * DC-3 bookkeeping
 * ------------------------------------------------------------------ */

/** Which sidecar layer a revision-relative file belongs to, for `applied_to`. */
export function targetForPath(path: string): RedactionTarget | null {
  if (path.startsWith('dom/')) return 'dom'
  if (path.startsWith('ax/')) return 'ax'
  if (path === 'network.har') return 'har'
  if (path === 'input_events.ndjson') return 'input'
  // `console.ndjson` has no member in DC-4's `RedactionTarget` union. The text
  // is still redacted and the hit still appears in `report.hits`; it simply
  // cannot be named in `applied_to` without widening a shared contract that
  // this milestone does not own. Recorded in the handover rather than fudged.
  return null
}

/* ------------------------------------------------------------------ *
 * seal()
 * ------------------------------------------------------------------ */

/**
 * The only way to produce a `SealedSidecar`.
 *
 * Consumes the draft *and* the side files, because FR-SEC.2's acceptance says
 * "inspected by any means, including raw file access" — sealing only the root
 * JSON would leave the actual leak vectors untouched while the type system
 * reported success.
 *
 * Throws on binary file contents rather than passing them through unscanned: a
 * silent pass-through is exactly the quiet failure this module exists to
 * prevent. The state layer is all text in M1a; a pixel export will need a
 * deliberate decision here, not an accident.
 */
export function seal(
  draft: SidecarDraft,
  files: readonly RevisionFile[],
  policy: SealPolicy = {}
): SealedRevision {
  const { patterns, invalidRules } = compilePatterns(policy)
  const suppressed = [...new Set(policy.suppressedValues ?? [])].filter((v) => v.length >= 4)

  const acc: ScanAccumulator = { hits: new Map(), tierA: new Map() }
  const perSite: Array<{ site: string; acc: ScanAccumulator }> = []

  // Files first, so the sidecar's `redactions[]` can name every layer touched.
  const sealedFiles: RevisionFile[] = []
  let bytesScanned = 0
  for (const file of files) {
    if (typeof file.contents !== 'string') {
      throw new Error(
        `seal(): ${file.path} has binary contents. Tier B can only scan text, and passing ` +
          'binary through unscanned would defeat the chokepoint. Add an explicit binary policy first.'
      )
    }
    const siteAcc: ScanAccumulator = { hits: new Map(), tierA: new Map() }
    const contents = redactString(file.contents, patterns, suppressed, siteAcc)
    bytesScanned += Buffer.byteLength(file.contents, 'utf8')
    sealedFiles.push({ path: file.path, contents })
    perSite.push({ site: file.path, acc: siteAcc })
  }

  // The draft's own strings. `finalize` enforces DC-2 before anything is scanned,
  // so an unexplained null fails here rather than on disk.
  const finalized = finalize(draft)
  const sidecarAcc: ScanAccumulator = { hits: new Map(), tierA: new Map() }
  const redactedSidecar = redactDeep(finalized, patterns, suppressed, sidecarAcc) as Sidecar
  perSite.push({ site: 'sidecar', acc: sidecarAcc })

  // DC-3: one `redactions[]` entry per pattern, naming every layer it touched.
  const targetsByPattern = new Map<string, Set<RedactionTarget>>()
  const hits: SealHit[] = []
  const tierAFailures: TierAFailure[] = []

  for (const { site, acc: siteAcc } of perSite) {
    const target = site === 'sidecar' ? null : targetForPath(site)
    for (const [patternId, { label, count }] of siteAcc.hits) {
      hits.push({ patternId, label, site, count })
      acc.hits.set(patternId, { label, count: (acc.hits.get(patternId)?.count ?? 0) + count })
      if (target) {
        const set = targetsByPattern.get(patternId) ?? new Set<RedactionTarget>()
        set.add(target)
        targetsByPattern.set(patternId, set)
      } else if (!targetsByPattern.has(patternId)) {
        targetsByPattern.set(patternId, new Set<RedactionTarget>())
      }
    }
    for (const [, failure] of siteAcc.tierA) {
      tierAFailures.push({ ...failure, site })
    }
  }

  const redactions: Redaction[] = [...acc.hits.entries()].map(([patternId, { label, count }]) => ({
    // Text redaction has no pixel region. A zero rect says "not a pixel
    // redaction" honestly, rather than inventing coordinates.
    region: [0, 0, 0, 0] as [number, number, number, number],
    kind: 'solid' as const,
    reason: `${label} (${patternId}) ×${count}`,
    applied_to: [...(targetsByPattern.get(patternId) ?? [])]
  }))

  const sidecar: Sidecar = {
    ...redactedSidecar,
    redactions: [...redactedSidecar.redactions, ...redactions]
  }

  return {
    sidecar: sidecar as SealedSidecar,
    files: sealedFiles,
    report: {
      hits,
      tierAFailures,
      filesScanned: files.length,
      bytesScanned,
      invalidRules
    }
  }
}
