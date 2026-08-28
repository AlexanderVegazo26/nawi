import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LibraryItem } from '@shared/types'
import { LibraryView } from './LibraryView'
import { GeneratedContent, OfflineBanner } from './ui'

/**
 * Rendered-output assertions for the PRD-002 §5 and §7 states.
 *
 * These exist because the E2E equivalents could not be made to fail: the real
 * library load completes in a few milliseconds, so a Playwright assertion about
 * the loading state passes whether the branch renders a skeleton or the
 * forbidden full-screen spinner. Rendering the component directly puts the
 * branch under test instead of racing it.
 */

const noop = (): void => undefined
const asyncNoop = async (): Promise<void> => undefined

function renderLibrary(over: Partial<Parameters<typeof LibraryView>[0]> = {}): string {
  return renderToStaticMarkup(
    <LibraryView
      items={[] as LibraryItem[]}
      loading={false}
      error={null}
      onReload={noop}
      onOpen={noop}
      onDelete={asyncNoop}
      onRename={asyncNoop}
      notify={noop}
      onNewCapture={noop}
      {...over}
    />
  )
}

describe('UX-STA.2 — the loading state is skeletons, never a full-screen spinner', () => {
  it('renders skeleton cards while loading', () => {
    const html = renderLibrary({ loading: true })
    expect(html).toContain('data-testid="library-skeleton"')
  })

  it('does not render the forbidden blocking spinner', () => {
    // "Never a full-screen blocking spinner" is the requirement's own wording.
    //
    // The marker is `animate-spin`, which is the `Spinner` component's rotating
    // ring. Deliberately NOT the string "Loading your library…" — the skeleton
    // keeps that as its own `sr-only` label, because a screen-reader user still
    // needs to be told the grid is loading. Asserting on the text would have
    // failed on correct code and passed on nothing useful.
    const html = renderLibrary({ loading: true })
    expect(html).not.toContain('animate-spin')
    // The skeleton's own pulse is what should be there instead.
    expect(html).toContain('animate-pulse')
  })

  it('keeps the header, search and primary action mounted during the load', () => {
    // The real defect: the spinner `return`ed before the header, so search and
    // New capture were gone while the index was read.
    const html = renderLibrary({ loading: true })
    expect(html).toContain('aria-label="Search captures"')
    expect(html).toContain('New capture')
    expect(html).toContain('Library')
  })

  it('marks the loading region busy for assistive technology', () => {
    expect(renderLibrary({ loading: true })).toContain('aria-busy="true"')
  })

  it('stops rendering skeletons once loading finishes', () => {
    expect(renderLibrary({ loading: false })).not.toContain('data-testid="library-skeleton"')
  })
})

describe('UX-STA.1 / §9 — the empty state offers the primary action with a real hotkey', () => {
  it('renders a resolved chord, never a raw Electron accelerator', () => {
    const html = renderLibrary({ loading: false })
    expect(html).toContain('to take your first capture')
    expect(html).not.toContain('CommandOrControl')
  })
})

/*
 * §1 P5's delete-confirm copy is NOT asserted here.
 *
 * It was, as "the rendered view never contains 'can't be undone'" — and that
 * assertion was vacuous: the confirm modal only mounts once `confirmDelete`
 * state is set, so it is absent from this render regardless, and restoring the
 * old P5-violating copy left the test green. It is asserted instead in
 * `e2e/conformance.spec.ts`, which opens the real modal first.
 */

describe('UX-STA.4 — the offline banner', () => {
  it('uses PRD-002’s exact copy', () => {
    const html = renderToStaticMarkup(<OfflineBanner online={false} />)
    expect(html).toContain('Offline — captures are saved locally and will sync.')
  })

  it('is a status, not an alert — "no modal, no red"', () => {
    const html = renderToStaticMarkup(<OfflineBanner online={false} />)
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('role="dialog"')
    // The danger token is what "red" means in this codebase.
    expect(html).not.toContain('danger')
  })

  it('renders nothing at all when online', () => {
    expect(renderToStaticMarkup(<OfflineBanner online />)).toBe('')
  })
})

describe('UX-VIS.4 — the generated-content signature', () => {
  it('carries both halves of the signature: a glyph and a tinted background', () => {
    const html = renderToStaticMarkup(<GeneratedContent>Some step text</GeneratedContent>)
    expect(html).toContain('data-generated="true"')
    expect(html).toContain('<svg')
    expect(html).toContain('bg-accent/10')
  })

  it('carries the marking in text, not colour alone (UX-A11Y.4)', () => {
    const html = renderToStaticMarkup(<GeneratedContent>Some step text</GeneratedContent>)
    expect(html).toContain('Suggested')
    // The glyph must not be announced; the words must be.
    expect(html).toContain('aria-hidden="true"')
  })

  it('§9 — labels generated content as suggested, never as fact', () => {
    const html = renderToStaticMarkup(
      <GeneratedContent label="Suggested step text">Click Save</GeneratedContent>
    )
    expect(html).toContain('Suggested step text')
  })
})
