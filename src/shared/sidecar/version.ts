/**
 * DC-6 compatibility rules, in one place.
 *
 *   "`schema_version` is semver. Additive fields are minor; removals or type
 *    changes are major. Consumers must ignore unknown fields."
 *
 * Which means the only two questions a reader has are: is the major the one I
 * understand, and is the file *newer* than me (so unknown fields are expected
 * rather than suspicious)? Both are answered here so no call site re-derives it.
 *
 * ZERO runtime imports — the renderer consumes this module directly.
 */

/** The version this build writes. */
export const SCHEMA_VERSION = '1.0'

export interface SemVer {
  major: number
  minor: number
}

/**
 * DC-4's `schema_version` is `"major.minor"`. A patch segment is tolerated on
 * read (it carries no contract meaning) but never written.
 */
export function parseSchemaVersion(value: unknown): SemVer | null {
  if (typeof value !== 'string') return null
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(value.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]) }
}

export type CompatibilityStatus =
  /** Same major, at or below our minor. Fully understood. */
  | 'compatible'
  /**
   * Same major, higher minor. Readable *because* additive fields are minor and
   * unknown fields are preserved — this is the case `SidecarLoose` exists for.
   */
  | 'forward_compatible'
  /** Different major: removals or type changes. Do not guess at the contents. */
  | 'incompatible'
  /** Not a version string at all. */
  | 'unparseable'

export interface CompatibilityResult {
  status: CompatibilityStatus
  /** Human-readable, safe to surface in a log or an agent error. */
  reason: string
}

/**
 * @param fileVersion the `schema_version` read from a sidecar (untrusted).
 * @param readerVersion the version this build understands; overridable for tests.
 */
export function checkCompatibility(
  fileVersion: unknown,
  readerVersion: string = SCHEMA_VERSION
): CompatibilityResult {
  const file = parseSchemaVersion(fileVersion)
  if (!file) {
    return { status: 'unparseable', reason: `schema_version is not semver: ${JSON.stringify(fileVersion)}` }
  }
  const reader = parseSchemaVersion(readerVersion)
  if (!reader) {
    // A programmer error, not a data error — fail loudly rather than guessing.
    throw new Error(`reader schema version is not semver: ${readerVersion}`)
  }

  if (file.major !== reader.major) {
    return {
      status: 'incompatible',
      reason: `sidecar schema ${file.major}.${file.minor} has a different major than this build's ${reader.major}.${reader.minor}; fields may have been removed or retyped`
    }
  }
  if (file.minor > reader.minor) {
    return {
      status: 'forward_compatible',
      reason: `sidecar schema ${file.major}.${file.minor} is newer than this build's ${reader.major}.${reader.minor}; unknown fields are preserved, not interpreted`
    }
  }
  return { status: 'compatible', reason: 'same major, at or below this build’s minor' }
}

/** True when the sidecar can be read at all. Forward-compatible counts as readable. */
export function isReadable(fileVersion: unknown, readerVersion: string = SCHEMA_VERSION): boolean {
  const { status } = checkCompatibility(fileVersion, readerVersion)
  return status === 'compatible' || status === 'forward_compatible'
}
