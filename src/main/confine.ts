import { isAbsolute, relative } from 'node:path'

/**
 * Whether `path` is strictly inside `root` (both already resolved). The one home-folder sandbox check shared by
 * every tool that reads a user-named file (flow files, APKs).
 */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  // `..flows/x` is a folder named "..flows" inside the root; only `..` as a whole segment leaves it.
  return rel !== '' && !/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel)
}
