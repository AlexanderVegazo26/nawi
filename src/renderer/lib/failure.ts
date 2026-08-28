/**
 * UX-STA.3 — "Failure states name what failed, what still worked, and what to do."
 *
 * The shipped code passed raw `res.error` strings straight into a toast, which
 * gives only the first of the three. That is the difference between "Export
 * failed: EACCES" and "Couldn't export that copy. Your capture is still in your
 * library. Pick a different folder and try again." — the second tells the user
 * their work is not lost, which is the thing they actually want to know.
 *
 * A function rather than a convention, so the second and third clauses cannot
 * be quietly forgotten at a call site: `intact` and `next` are required.
 */
export interface Failure {
  /** What failed, in plain words. Never blames the user (§9). */
  failed: string
  /** What survived. This is the clause that stops a failure reading as data loss. */
  intact: string
  /** The next action available to them. */
  next: string
}

export function failureMessage(f: Failure): string {
  return [sentence(f.failed), sentence(f.intact), sentence(f.next)].join(' ')
}

function sentence(s: string): string {
  const t = s.trim()
  if (t.length === 0) return ''
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/**
 * Wraps a low-level error in the three-part shape.
 *
 * The raw message is appended rather than dropped: a support conversation needs
 * the underlying cause, and hiding it entirely trades one unhelpful message for
 * another.
 */
export function failureFrom(cause: string, f: Failure): string {
  const detail = cause.trim()
  return detail.length > 0 ? `${failureMessage(f)} (${detail})` : failureMessage(f)
}
