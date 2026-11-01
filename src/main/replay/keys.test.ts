import { describe, expect, it } from 'vitest'
import { parseKey, UnknownKeyError } from './keys'

describe('parseKey', () => {
  it('maps Enter to a key that inserts "\\r" so Chrome submits forms', () => {
    expect(parseKey('Enter')).toEqual({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, hold: [], text: '\r' })
  })

  it('maps named keys without text (Tab, ArrowDown, F5)', () => {
    expect(parseKey('Tab')).toMatchObject({ code: 'Tab', windowsVirtualKeyCode: 9 })
    expect(parseKey('Tab').text).toBeUndefined()
    expect(parseKey('ArrowDown')).toMatchObject({ code: 'ArrowDown', windowsVirtualKeyCode: 40 })
    expect(parseKey('F5')).toMatchObject({ code: 'F5', windowsVirtualKeyCode: 116 })
  })

  it('knows the lock, system and media keys a recording can contain', () => {
    expect(parseKey('CapsLock')).toMatchObject({ code: 'CapsLock', windowsVirtualKeyCode: 20 })
    expect(parseKey('PrintScreen')).toMatchObject({ windowsVirtualKeyCode: 44 })
    expect(parseKey('MediaPlayPause')).toMatchObject({ windowsVirtualKeyCode: 179 })
  })

  it('parses chords with modifier aliases, and drops text while Control/Meta/Alt is held', () => {
    const k = parseKey('ctrl+Shift+k')
    expect(k).toMatchObject({ key: 'K', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 | 8, hold: ['Control', 'Shift'] })
    expect(k.text, 'Control+Shift+K inserts nothing').toBeUndefined()
    expect(parseKey('Cmd+Enter').text).toBeUndefined()
  })

  it('keeps text for Shift chords and single characters', () => {
    expect(parseKey('Shift+a')).toMatchObject({ key: 'A', text: 'A', modifiers: 8 })
    expect(parseKey('7')).toMatchObject({ code: 'Digit7', text: '7' })
    expect(parseKey('/')).toMatchObject({ code: 'Slash', windowsVirtualKeyCode: 191, text: '/' })
    expect(parseKey('é')).toMatchObject({ key: 'é', code: '', text: 'é' })
  })

  it('treats a literal "+" as a key, alone or after modifiers', () => {
    expect(parseKey('+')).toMatchObject({ key: '+', modifiers: 0 })
    expect(parseKey('Control++')).toMatchObject({ key: '+', modifiers: 2 })
  })

  it('rejects unknown modifiers, multi-character non-keys and prototype names with the reason', () => {
    expect(() => parseKey('Hyper+a')).toThrow(new UnknownKeyError('Hyper+a', '"Hyper" is not a modifier (Alt, Control, Meta, Shift)'))
    expect(() => parseKey('Enterr')).toThrow(/"Enterr" is neither a named key/)
    expect(() => parseKey('constructor')).toThrow(/neither a named key/)
    expect(() => parseKey('constructor+a')).toThrow(/is not a modifier/)
    expect(() => parseKey('Control+')).toThrow(/empty part/)
  })
})
