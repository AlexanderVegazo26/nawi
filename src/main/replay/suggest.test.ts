import { describe, expect, it } from 'vitest'
import { MIN_SUGGEST_SCORE, pickSuggestion, stepQuery, words, type SnapshotEntry } from './suggest'

const entry = (i: number, role: string, name: string, extra: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
  i,
  role,
  name,
  editable: false,
  select: false,
  ...extra
})

describe('words', () => {
  it('folds case and accents, splits camelCase / kebab / snake, and drops stop words and placeholders', () => {
    expect([...words('Click the "Guardar Configuración" button for ${vars.user}')]).toEqual(['guardar', 'configuracion'])
    expect([...words('saveNote-button_primary')]).toEqual(['save', 'note', 'primary'])
    expect(words('Click the button').size, 'an intent made only of action words says nothing about which control').toBe(0)
  })
})

describe('stepQuery', () => {
  it('takes words from the intent and from the names its locators look for (role name, text, test id, id), not from CSS', () => {
    const q = stepQuery({ intent: 'Save the note' }, [
      { role: 'button', name: 'Save' },
      { text: 'Store it' },
      { testid: 'note-save' },
      { id: 'saveBtn' },
      { css: '.primary > span' }
    ])
    expect([...q.intent]).toEqual(['save', 'note'])
    expect([...q.locators].sort()).toEqual(['note', 'save', 'store'])
    expect([...q.roles]).toEqual(['button'])
  })
})

describe('pickSuggestion', () => {
  const q = stepQuery({ intent: 'Save the note' }, [{ role: 'button', name: 'Save' }, { css: '#save' }])

  it('picks the renamed control whose name shares the most words with the intent, over a control sharing fewer', () => {
    const snap = [entry(0, 'link', 'Home'), entry(1, 'button', 'Discard note'), entry(2, 'button', 'Save note')]
    expect(pickSuggestion(snap, 'click', q)).toEqual({ entry: snap[2], score: 1, basis: 'intent' })
  })

  it('gives no suggestion when two controls are equally close (a guess between them would be a coin toss)', () => {
    const snap = [entry(0, 'button', 'Save draft'), entry(1, 'button', 'Save copy')]
    expect(pickSuggestion(snap, 'click', q), JSON.stringify(snap)).toBeNull()
  })

  it(`gives no suggestion when the best control scores under ${MIN_SUGGEST_SCORE}`, () => {
    const far = stepQuery({ intent: 'Save the edited note to the shared workspace' }, [{ css: '#save' }])
    const snap = [entry(0, 'button', 'Publish')]
    expect(pickSuggestion(snap, 'click', far)).toBeNull()
    expect(pickSuggestion([entry(0, 'button', 'Note settings and sharing options')], 'click', far), 'one shared word of many is not enough').toBeNull()
  })

  it('compares scores before capping them at 1: the exact name with the right role beats a longer one with the same role', () => {
    const exact = stepQuery({ intent: 'Save note' }, [{ role: 'button', name: 'Keep' }])
    const snap = [entry(0, 'button', 'Save note now'), entry(1, 'button', 'Save note')]
    expect(pickSuggestion(snap, 'click', exact), 'uncapped 1.15 vs 0.95: a clear winner').toMatchObject({ entry: { i: 1 }, score: 1 })
  })

  it('accepts a winner exactly MIN_MARGIN ahead despite float rounding (0.6 - 0.5)', () => {
    // intent words {alpha, beta, gamma, delta}: 3 shared of 4+6 -> 0.6, 2 shared of 4+4 -> 0.5.
    const qq = stepQuery({ intent: 'alpha beta gamma delta' }, [])
    const snap = [entry(0, 'button', 'alpha beta zeta eta'), entry(1, 'button', 'alpha beta gamma eta theta iota')]
    expect(pickSuggestion(snap, 'click', qq)).toMatchObject({ entry: { i: 1 }, score: 0.6 })
  })

  it('gives no suggestion for a page whose snapshot was too large to read whole', () => {
    expect(pickSuggestion({ tooMany: 2400 }, 'click', q)).toBeNull()
  })

  it('only offers text fields to fill steps and pickers to select steps', () => {
    const fillQ = stepQuery({ intent: 'Type the email' }, [{ role: 'textbox', name: 'E-mail' }])
    const snap = [entry(0, 'button', 'Email'), entry(1, 'textbox', 'Email address', { editable: true })]
    expect(pickSuggestion(snap, 'fill', fillQ)?.entry.i, 'the button has the closer name but cannot be typed into').toBe(1)
    const selectQ = stepQuery({ intent: 'Choose the country' }, [])
    const pickers = [entry(0, 'button', 'Country'), entry(1, 'combobox', 'Country', { select: true })]
    expect(pickSuggestion(pickers, 'select', selectQ)?.entry.i).toBe(1)
  })

  it('falls back to the names its locators looked for when the step has no intent, and says so', () => {
    const noIntent = stepQuery({}, [{ role: 'button', name: 'Save note' }])
    const snap = [entry(0, 'button', 'Save the note')]
    expect(pickSuggestion(snap, 'click', noIntent)).toMatchObject({ entry: { i: 0 }, basis: 'locators' })
  })

  it('ignores anything that is not a snapshot entry, and answers nothing without words to compare', () => {
    expect(pickSuggestion(null, 'click', q)).toBeNull()
    expect(pickSuggestion([{ i: 'x', role: 'button', name: 'Save note' }, 'junk', entry(3, 'button', 'Save note')], 'click', q)?.entry.i).toBe(3)
    expect(pickSuggestion([entry(0, 'button', 'Save note')], 'click', stepQuery({ intent: 'Click the button' }, [{ css: '#x' }]))).toBeNull()
  })

  it('is deterministic: the same snapshot in any order gives the same control', () => {
    const snap = [entry(0, 'button', 'Discard note'), entry(1, 'button', 'Save note'), entry(2, 'link', 'Notes')]
    const want = pickSuggestion(snap, 'click', q)
    for (const order of [[2, 1, 0], [1, 0, 2], [0, 2, 1]]) {
      expect(pickSuggestion(order.map((i) => snap[i]), 'click', q), `order ${order.join(',')}`).toEqual(want)
    }
  })
})
