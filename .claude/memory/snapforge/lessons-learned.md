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
