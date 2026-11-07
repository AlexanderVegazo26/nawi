import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Whether `path` is strictly inside `root` (both already resolved). The one home-folder sandbox check shared by
 * every tool that reads a user-named file (flow files, APKs).
 */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  // `..flows/x` is a folder named "..flows" inside the root; only `..` as a whole segment leaves it.
  return rel !== '' && !/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel)
}

/**
 * Whether `path` is inside one of `roots`, compared with each root's real path (a home folder reached through a
 * link still counts). With `lexical`, also with the root as given: for checking a path *before* touching the disk,
 * so a refusal can't tell the caller whether something outside the roots exists.
 */
export async function insideRoots(path: string, roots: string[], lexical = false): Promise<boolean> {
  if (lexical && roots.some((r) => within(resolve(r), resolve(path)))) return true
  const real = await Promise.all(roots.map((r) => realpath(r).catch(() => null)))
  return real.some((r) => r !== null && within(r, path))
}
