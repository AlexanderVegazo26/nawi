import * as DialogPrimitive from '@radix-ui/react-dialog'
import type * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn/ui `dialog`, adapted for this app. Two deliberate departures from the
 * stock component — both are load-bearing, so read before regenerating:
 *
 * 1. NO `DialogPortal`. The stock component wraps content in a portal to
 *    `document.body`. `react-dom/server` cannot render `createPortal`, and the
 *    PRD-002 §5/§7 state assertions in `states.test.tsx` run under
 *    `renderToStaticMarkup` in a node environment (vitest.config.ts sets
 *    `environment: 'node'`). Portalling would make any test that mounts a
 *    dialog throw rather than fail informatively. Rendering in place also
 *    matches what the hand-rolled `Modal` did, so nothing about stacking or
 *    z-index changes.
 *
 * 2. No `data-[state=open]:animate-*` classes. Those come from `tw-animate-css`,
 *    which is not installed; on Tailwind v4 they would compile to nothing. The
 *    previous modal had no enter/exit animation either, so this is parity, not
 *    a regression — and styles.css clamps all animation to 1ms under
 *    `prefers-reduced-motion` regardless.
 */

export const Dialog = DialogPrimitive.Root
export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description
export const DialogClose = DialogPrimitive.Close

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element {
  return (
    <DialogPrimitive.Overlay
      className={cn('fixed inset-0 z-50 bg-scrim/70', className)}
      {...props}
    />
  )
}

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>): React.JSX.Element {
  return (
    <DialogPrimitive.Content
      className={cn(
        'surface fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5 shadow-2xl',
        className
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  )
}
