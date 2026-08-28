# Lessons learned — Nawi

## 2026-08-28 — `Button` silently dropped `data-autofocus` (accessibility)
`src/renderer/components/ui.tsx` `Button` does not spread unknown props onto the
DOM, but three call sites wrote `<Button data-autofocus>`. It typechecked, and
`Modal`'s initial-focus query found nothing, so **every modal in the app fell
back to focusing its own container** — a silent UX-A11Y.3 failure. Found only by
an e2e assertion on `toBeFocused()`, never by typecheck or by reading the code.
Fixed with an explicit `autoFocusInModal` prop.

Takeaway: a wrapper component that does not spread props turns an attribute typo
into dead code with no diagnostic. Assert focus destination in tests rather than
trusting the attribute is wired.

## 2026-08-28 — Canvas cannot honour `prefers-reduced-motion` via CSS
The UX-ANN.2 badge-renumber cross-fade is painted with `fillText`, so the
`@media (prefers-reduced-motion)` block in `styles.css` has no reach over it.
Adding a `.motion-*` class to the canvas would typecheck, look compliant, and do
nothing. The branch lives in JS (`src/renderer/lib/motion.ts`), and the reduced
path substitutes a live-region announcement rather than removing feedback.

## 2026-08-28 — Two PRD-002 state tests passed while asserting nothing
During the PRD-002 conformance pass, two new tests went green for the wrong reason
and were only caught by the mandated "prove it can fail" step:

1. An **E2E** assertion that the Library loading state was skeletons and not a
   full-screen spinner. The real library read finishes in a few milliseconds, so
   restoring the forbidden `Spinner` left the test green — it was racing the
   branch, never testing it. Replaced with a `react-dom/server` render of
   `LibraryView` with `loading` forced (`src/renderer/components/states.test.tsx`).
2. A **render** assertion that the delete confirm no longer says "can't be undone".
   The confirm modal only mounts once `confirmDelete` state is set, so it was
   absent from the render regardless and the old P5-violating copy passed. Moved
   to E2E, which opens the real modal first.

Takeaway: a state-branch test must *force* the branch. If the assertion runs
against whatever the component happened to render, a fast-completing async path
and a conditionally-mounted subtree both produce permanent green. Both failures
had the same shape — the thing under test was not on screen when the assertion ran.

Also: the repo has no DOM test runner (vitest `environment: 'node'`, no
testing-library/jsdom). `react-dom/server`'s `renderToStaticMarkup` covers
render-output assertions with no new dependency; `vitest.config.ts` `include` was
widened to `*.test.tsx` for it.

## 2026-08-28 — `key in record` walks the prototype chain
`isNudgeKey` used `key in ARROWS` and answered true for `'toString'`, which would
have driven the overlay's region rect to `NaN` coordinates from a stray keypress.
A `KeyboardEvent.key` is arbitrary text; own-property lookup
(`Object.prototype.hasOwnProperty.call`) is the only safe form. Caught by a test
written for a different reason.
