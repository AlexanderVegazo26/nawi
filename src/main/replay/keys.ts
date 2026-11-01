/**
 * `press` step keys → CDP `Input.dispatchKeyEvent` parameters.
 *
 * A flow key is a `KeyboardEvent.key` name (`Enter`, `ArrowDown`, `F5`), a
 * single character (`a`, `/`), or a chord joined with `+` (`Control+a`,
 * `Shift+Tab`, `Meta+Enter`). Chrome needs `code` and `windowsVirtualKeyCode`
 * as well as `key` before it runs default actions (Enter submitting a form,
 * Tab moving focus), and `text` for keys that insert something.
 */

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const
export type ModifierName = keyof typeof MODIFIER_BITS

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  alt: 'Alt',
  option: 'Alt',
  control: 'Control',
  ctrl: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  shift: 'Shift'
}

interface NamedKey {
  code: string
  keyCode: number
  text?: string
}

const NAMED_KEYS: Record<string, NamedKey> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Insert: { code: 'Insert', keyCode: 45 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ContextMenu: { code: 'ContextMenu', keyCode: 93 },
  CapsLock: { code: 'CapsLock', keyCode: 20 },
  NumLock: { code: 'NumLock', keyCode: 144 },
  ScrollLock: { code: 'ScrollLock', keyCode: 145 },
  Pause: { code: 'Pause', keyCode: 19 },
  PrintScreen: { code: 'PrintScreen', keyCode: 44 },
  Clear: { code: 'NumpadClear', keyCode: 12 },
  Help: { code: 'Help', keyCode: 47 },
  AudioVolumeMute: { code: 'AudioVolumeMute', keyCode: 173 },
  AudioVolumeDown: { code: 'AudioVolumeDown', keyCode: 174 },
  AudioVolumeUp: { code: 'AudioVolumeUp', keyCode: 175 },
  MediaTrackNext: { code: 'MediaTrackNext', keyCode: 176 },
  MediaTrackPrevious: { code: 'MediaTrackPrevious', keyCode: 177 },
  MediaStop: { code: 'MediaStop', keyCode: 178 },
  MediaPlayPause: { code: 'MediaPlayPause', keyCode: 179 },
  BrowserBack: { code: 'BrowserBack', keyCode: 166 },
  BrowserForward: { code: 'BrowserForward', keyCode: 167 },
  BrowserRefresh: { code: 'BrowserRefresh', keyCode: 168 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
  Shift: { code: 'ShiftLeft', keyCode: 16 }
}
for (let n = 1; n <= 24; n++) NAMED_KEYS[`F${n}`] = { code: `F${n}`, keyCode: 111 + n }

const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  ' ': { code: 'Space', keyCode: 32 },
  '-': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 }
}

export interface KeyPress {
  key: string
  code: string
  windowsVirtualKeyCode: number
  /** Bitmask of held modifiers (CDP's Alt=1, Control=2, Meta=4, Shift=8). */
  modifiers: number
  /** Modifier keys to hold down around the key, in order. */
  hold: ModifierName[]
  /** What the key inserts; absent for keys that insert nothing or while Control/Meta/Alt is held. */
  text?: string
}

export class UnknownKeyError extends Error {
  constructor(key: string, why: string) {
    super(`cannot press "${key}": ${why}`)
    this.name = 'UnknownKeyError'
  }
}

/** Parse a flow key (`Enter`, `a`, `Control+Shift+K`) into what CDP needs. */
export function parseKey(spec: string): KeyPress {
  // A literal "+" is a key of its own; "Control++" is Control and "+".
  const parts = spec === '+' ? ['+'] : spec.endsWith('++') ? [...spec.slice(0, -2).split('+'), '+'] : spec.split('+')
  if (parts.some((p) => p === '')) throw new UnknownKeyError(spec, 'empty part in the chord')
  const main = parts[parts.length - 1]
  const hold: ModifierName[] = []
  let modifiers = 0
  for (const raw of parts.slice(0, -1)) {
    const mod = Object.hasOwn(MODIFIER_ALIASES, raw.toLowerCase()) ? MODIFIER_ALIASES[raw.toLowerCase()] : undefined
    if (!mod) throw new UnknownKeyError(spec, `"${raw}" is not a modifier (Alt, Control, Meta, Shift)`)
    if (!hold.includes(mod)) hold.push(mod)
    modifiers |= MODIFIER_BITS[mod]
  }
  const commandHeld = (modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt)) !== 0

  const named = Object.hasOwn(NAMED_KEYS, main) ? NAMED_KEYS[main] : undefined
  if (named) {
    const key = main === 'Space' ? ' ' : main
    return {
      key,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode,
      modifiers,
      hold,
      ...(named.text !== undefined && !commandHeld ? { text: named.text } : {})
    }
  }

  if ([...main].length !== 1) {
    throw new UnknownKeyError(spec, `"${main}" is neither a named key (Enter, Tab, ArrowDown, F5...) nor one character`)
  }

  const shift = (modifiers & MODIFIER_BITS.Shift) !== 0
  let code: string
  let keyCode: number
  if (/^[a-z]$/i.test(main)) {
    code = `Key${main.toUpperCase()}`
    keyCode = main.toUpperCase().charCodeAt(0)
  } else if (/^[0-9]$/.test(main)) {
    code = `Digit${main}`
    keyCode = main.charCodeAt(0)
  } else if (Object.hasOwn(PUNCTUATION, main)) {
    ;({ code, keyCode } = PUNCTUATION[main])
  } else {
    // Any other character (é, +, ñ, emoji): no physical key to name, but Chrome
    // still inserts `text`, which is what a flow pressing it means.
    code = ''
    keyCode = 0
  }
  const key = shift && /^[a-z]$/.test(main) ? main.toUpperCase() : main
  return {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    modifiers,
    hold,
    ...(commandHeld ? {} : { text: key })
  }
}
