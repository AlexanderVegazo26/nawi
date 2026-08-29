import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn/ui's class merger. Components copied in via `npx shadcn add` import
 * this from `@/lib/utils` — the path is declared in `components.json`, so the
 * name and location are fixed by that contract rather than chosen here.
 *
 * `twMerge` resolves conflicts between Tailwind classes (last one wins), which
 * is what lets a caller's `className` override a component's own defaults.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
