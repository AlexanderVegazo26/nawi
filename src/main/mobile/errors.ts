/**
 * Why an APK could not be read, and the one thing to do about it (roadmap M1: "each failure gives one specific fix
 * instead of a stack trace"). Plain errors, not ToolError: this module has no MCP dependency, and the inspect_apk
 * tool maps `kind` onto its declared codes.
 */
export type ApkErrorKind =
  /** No file at that path. */
  | 'not_found'
  /** The file or path is not something Nawi will read (not an APK, corrupt, outside the allowed folders). */
  | 'invalid'
  /** A real Android package Nawi cannot read yet (an .aab, a zip64 archive). */
  | 'unsupported'

export class ApkError extends Error {
  readonly kind: ApkErrorKind
  /** One sentence telling the user what to do next. */
  readonly fix: string

  constructor(kind: ApkErrorKind, message: string, fix: string) {
    super(`${message} ${fix}`)
    this.name = 'ApkError'
    this.kind = kind
    this.fix = fix
  }
}

/** A malformed archive or manifest: always the same fix, so callers only say what was wrong. */
export function corrupt(what: string): ApkError {
  return new ApkError('invalid', `This file is not a readable APK: ${what}.`, 'Download or build the APK again and retry; a partial download looks like this.')
}
