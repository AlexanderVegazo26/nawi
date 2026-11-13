import type { PermissionAnswer } from '../../shared/flow/schema'
import { labelOf, PERMISSION_PACKAGES } from './blockers'
import type { UiNode, UiScreen } from './hierarchy'

/**
 * Roadmap M5d-6: Android's runtime permission prompt as the replayer and the recorder see it. The prompt is the
 * permission controller's own window (a screen dump while it shows holds only that window, not the app's), and its
 * buttons keep the same view ids across versions and vendors even where the package name differs
 * (`com.android.permissioncontroller:id/...` inside `com.google.android.permissioncontroller`), so an answer is found
 * by its id, never by its label (which follows the device's language).
 */

/**
 * The prompt's buttons for each answer, by view id name, best first: when a prompt shows two buttons for one answer,
 * a step taps the first (plain "Don't allow" before its "don't ask again" form, which denies for good). `allow` also
 * covers "Allow all" (photos) and Android 10's "Allow all the time"; `deny` also covers the buttons that keep what the
 * app has when it asks for more ("Keep approximate location", "Keep while app is in use").
 */
export const ANSWER_BUTTON_IDS: Readonly<Record<PermissionAnswer, readonly string[]>> = {
  allow: ['permission_allow_button', 'permission_allow_all_button', 'permission_allow_always_button'],
  while_using: ['permission_allow_foreground_only_button'],
  once: ['permission_allow_one_time_button'],
  deny: ['permission_deny_button', 'permission_no_upgrade_button', 'permission_deny_and_dont_ask_again_button', 'permission_no_upgrade_and_dont_ask_again_button']
}

/** Each answer as the English prompt labels it, for messages. */
export const ANSWER_LABELS: Readonly<Record<PermissionAnswer, string>> = {
  allow: '"Allow"',
  while_using: '"While using the app"',
  once: '"Only this time"',
  deny: '"Don\'t allow"'
}

const BY_ID: ReadonlyMap<string, PermissionAnswer> = new Map(
  (Object.entries(ANSWER_BUTTON_IDS) as Array<[PermissionAnswer, readonly string[]]>).flatMap(([answer, ids]) => ids.map((id) => [id, answer] as const))
)

/** The view id name after `:id/`, or null for a view without one. */
const idName = (resourceId: string): string | null => /:id\/([A-Za-z0-9_]+)$/.exec(resourceId)?.[1] ?? null

/** Whether a window of Android's permission prompt is on screen. */
export const promptShown = (screen: UiScreen): boolean => screen.nodes.some((n) => PERMISSION_PACKAGES.has(n.package))

/** The answer a view of the prompt gives when tapped; null for any other view (a location accuracy choice, a text). */
export function answerOf(node: UiNode): PermissionAnswer | null {
  if (!PERMISSION_PACKAGES.has(node.package)) return null
  const name = idName(node.resource_id)
  return name === null ? null : (BY_ID.get(name) ?? null)
}

export interface PromptButton {
  answer: PermissionAnswer
  node: UiNode
  /** Its visible label ("While using the app"), for messages and step intents. */
  label: string
}

export interface PermissionPrompt {
  /** What Android asks ("Allow Camera to take pictures and record video?"); null when the dump has no message view. */
  message: string | null
  /** Its answer buttons, in screen order. */
  buttons: PromptButton[]
}

/** The prompt's button for `answer`, the best one when it shows two (ANSWER_BUTTON_IDS order). */
export function buttonFor(prompt: PermissionPrompt, answer: PermissionAnswer): PromptButton | undefined {
  const rank = (b: PromptButton): number => ANSWER_BUTTON_IDS[answer].indexOf(idName(b.node.resource_id) ?? '')
  return prompt.buttons.filter((b) => b.answer === answer).sort((a, b) => rank(a) - rank(b))[0]
}

/**
 * What tells one question of the prompt from the next: its message and the ids of its buttons (an app that asks
 * again after a "Don't allow" gets the same message with the "don't ask again" form of the button). Null for a
 * prompt not fully drawn (no message or no answer button: a window still laying out or closing).
 */
export function promptKey(prompt: PermissionPrompt): string | null {
  if (prompt.message === null || prompt.buttons.length === 0) return null
  return JSON.stringify([prompt.message, prompt.buttons.map((b) => b.node.resource_id)])
}

/** Android's permission prompt on `screen`, or null when none shows. */
export function permissionPrompt(screen: UiScreen): PermissionPrompt | null {
  const nodes = screen.nodes.filter((n) => PERMISSION_PACKAGES.has(n.package))
  if (nodes.length === 0) return null
  const message = nodes.find((n) => idName(n.resource_id) === 'permission_message')?.text.replace(/\s+/g, ' ').trim() || null
  const buttons = nodes.flatMap((node): PromptButton[] => {
    const answer = answerOf(node)
    return answer === null ? [] : [{ answer, node, label: labelOf(node) }]
  })
  return { message, buttons }
}
