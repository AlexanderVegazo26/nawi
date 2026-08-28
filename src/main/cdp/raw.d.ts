/**
 * Vite's `?raw` suffix, used by `probe.ts` to inline `inject/probe.js` as a
 * string. electron-vite's own `node.d.ts` declares `?asset`/`?nodeWorker` but
 * not `?raw`, and the web-side `vite/client` types are not in this project's
 * node tsconfig — so declare it here rather than widening the global types.
 */
declare module '*?raw' {
  const content: string
  export default content
}
