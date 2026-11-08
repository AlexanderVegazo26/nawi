import { REFERENCE } from '../../shared/flow/schema'
import { findAll, PERMISSION_PACKAGES, type UiLocator } from './blockers'
import { center, isTextField, type UiNode, type UiScreen } from './hierarchy'
import { shQuote } from './shell'

/**
 * Roadmap M2 (last slice): get past a login wall with a test account. A profile's `sign_in` section names the fields
 * of the app's sign-in form and the button that submits it; each field's value is a single `${secret.name}` or
 * `${env.NAME}` reference, so the account's password (or even its user name) is never written into the profile.
 * `mobile_open` resolves them from the call (the CLI: NAWI_SECRET_<name> and the shell's environment, like
 * `nawi run`), and when the sign-in form is on screen after the onboarding taps, it taps each field, clears it, types
 * the value with `input text` and taps the submit button.
 *
 * Typing goes through the device's shell, so only what `input text` can type is accepted (printable ASCII), and a
 * value is split so that `%s`, which `input text` turns into a space, is typed as written. The values are passed to
 * adb as arguments (visible to local process listings while adb runs, like any adb command): use a test account.
 * Pure, so tests pin it.
 */

export interface SignInField {
  /** The text field: every given locator field must match it exactly, and exactly one element on screen must. */
  field: UiLocator
  /** `${secret.name}` or `${env.NAME}`, nothing else. */
  value: string
}

export interface SignInSpec {
  fields: SignInField[]
  /** The button that submits the form. */
  submit: UiLocator
}

/**
 * A sign-in field's value: exactly one `${env.NAME}` or `${secret.name}` reference (the flow files' grammar), so no
 * literal account data lands in a profile. Null for anything else.
 */
export function signInReference(value: string): { ns: 'env' | 'secret'; name: string } | null {
  const whole = /^\$\{([^}]*)\}$/.exec(value)
  const ref = whole ? REFERENCE.exec(whole[1].trim()) : null
  return ref && (ref[1] === 'env' || ref[1] === 'secret') ? { ns: ref[1], name: ref[2] } : null
}
/** At most this many fields (user name, password, a one-time code, a tenant...). */
export const MAX_SIGN_IN_FIELDS = 5
/** Longest value typed (a long passphrase fits; `input text` gets slow beyond this). */
export const MAX_SIGN_IN_VALUE = 256
/** What `input text` can type: printable ASCII (the device's key map has no keys for the rest). */
export const TYPABLE_RE = /^[\x20-\x7e]*$/

export interface SignInInputs {
  env?: Readonly<Record<string, string | undefined>>
  secrets?: Readonly<Record<string, string | undefined>>
}

export type ResolvedSignIn =
  /** `secrets`: [name, value] of each secret typed, to scrub from what the open reports. */
  | { ok: true; values: string[]; secrets: Array<[name: string, value: string]> }
  /** `missing`: references the call did not supply (`secret.app_password`); `bad`: values `input text` can't type. */
  | { ok: false; missing: string[]; bad: string[] }

/** Each field's value, from the call's env and secrets. */
export function resolveSignIn(spec: SignInSpec, inputs: SignInInputs): ResolvedSignIn {
  const values: string[] = []
  const secrets: Array<[string, string]> = []
  const missing: string[] = []
  const bad: string[] = []
  for (const f of spec.fields) {
    // The profile schema already refuses anything else; this keeps openApp safe when called directly.
    const m = signInReference(f.value)
    if (!m) {
      bad.push(`${f.value.slice(0, 60)} (not a single \${secret.name} or \${env.NAME})`)
      continue
    }
    const ref = `${m.ns}.${m.name}`
    const v = m.ns === 'env' ? inputs.env?.[m.name] : inputs.secrets?.[m.name]
    if (v === undefined) {
      if (!missing.includes(ref)) missing.push(ref)
      continue
    }
    if (v.length === 0) bad.push(`\${${ref}} is empty`)
    else if (v.length > MAX_SIGN_IN_VALUE) bad.push(`\${${ref}} is longer than ${MAX_SIGN_IN_VALUE} characters`)
    else if (!TYPABLE_RE.test(v)) bad.push(`\${${ref}} has characters a device can't type with \`input text\` (only printable ASCII)`)
    else {
      values.push(v)
      if (m.ns === 'secret') secrets.push([m.name, v])
    }
  }
  return missing.length > 0 || bad.length > 0 ? { ok: false, missing, bad } : { ok: true, values, secrets }
}

/**
 * The `input text` command lines that type `value` as written. `input text` turns `%s` into a space, so the value is
 * cut between a `%` and an `s` that follows it: each piece is typed by its own command, and no piece holds `%s`.
 */
export function typeLines(value: string): string[] {
  const pieces: string[] = []
  let start = 0
  for (let i = 1; i < value.length; i++) {
    if (value[i - 1] === '%' && value[i] === 's') {
      pieces.push(value.slice(start, i))
      start = i
    }
  }
  pieces.push(value.slice(start))
  return pieces.filter((p) => p.length > 0).map((p) => `input text ${shQuote(p)}`)
}

/** The key presses that empty a field holding `length` characters: to its end, then that many deletes. */
export function clearLine(length: number): string | null {
  const n = Math.min(Math.max(0, length), MAX_SIGN_IN_VALUE)
  return n === 0 ? null : `input keyevent KEYCODE_MOVE_END${' KEYCODE_DEL'.repeat(n)}`
}

export interface Point {
  x: number
  y: number
}

export type Located = { ok: true; node: UiNode; at: Point } | { ok: false; why: string }

const describe = (loc: UiLocator): string =>
  Object.entries(loc)
    .map(([k, v]) => `${k} "${String(v).slice(0, 60)}"`)
    .join(', ')

/** One element of `pkg` the locator matches, enabled, with its center on the app's window. */
export function locateOnApp(screen: UiScreen, pkg: string, loc: UiLocator, what: string, textField = false): Located {
  const found = findAll(screen.nodes, loc).filter((n) => n.package === pkg)
  if (found.length === 0) return { ok: false, why: `no ${what} matching ${describe(loc)} on the screen` }
  if (found.length > 1) return { ok: false, why: `${found.length} elements match the ${what} (${describe(loc)}), so Nawi can't tell which one is meant` }
  const node = found[0]
  if (textField && !isTextField(node)) return { ok: false, why: `the ${what} (${describe(loc)}) is a ${node.class.replace(/^.*\./, '')}, not a text field` }
  if (!node.enabled) return { ok: false, why: `the ${what} (${describe(loc)}) is disabled` }
  const b = node.bounds
  if (b === null || b.right <= b.left || b.bottom <= b.top) return { ok: false, why: `the ${what} (${describe(loc)}) has no size on screen` }
  const at = center(b)
  const cover = coveredBy(screen, pkg, at)
  if (cover) return { ok: false, why: `the ${what} (${describe(loc)}) is covered by ${cover}` }
  return { ok: true, node, at }
}

/**
 * The package of a window of another app (the on-screen keyboard, a prompt) drawn over `at`, which would get a tap
 * there instead of `pkg`; null when nothing covers it.
 */
export function coveredBy(screen: UiScreen, pkg: string, at: Point): string | null {
  const cover = screen.nodes.find((n) => n.parent === null && n.package !== pkg && n.package !== '' && n.bounds !== null && at.x >= n.bounds.left && at.x < n.bounds.right && at.y >= n.bounds.top && at.y < n.bounds.bottom)
  return cover ? cover.package : null
}

/** Whether a sign-in step can start on this screen: the app is in front, not Android's permission prompt. */
export function promptInFront(screen: UiScreen): boolean {
  return screen.nodes.some((n) => PERMISSION_PACKAGES.has(n.package))
}
