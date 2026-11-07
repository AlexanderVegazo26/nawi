/**
 * Roadmap M2 (third slice, M2c; M3 reuses it and its inventory fields): read the screen of an Android device as data. `uiautomator dump`
 * writes the accessibility tree of what is on screen as XML; this turns that XML into a flat list of nodes in
 * document order (each with its depth and parent), so callers can look for a dialog, a button or a password field
 * without a DOM.
 *
 * The dump comes from the device, i.e. from the app under test, so it is untrusted input: the parser only knows the
 * two element names uiautomator writes (`hierarchy`, `node`), caps the size, node count and depth, and never
 * resolves anything (entities are the five XML ones plus numeric references).
 */

/** A dump of a busy screen is ~100 KB. Equal to the cap on adb's text output (MAX_TEXT_OUTPUT, doctor.ts). */
export const MAX_DUMP_BYTES = 1024 * 1024
export const MAX_NODES = 10_000
export const MAX_DEPTH = 256

export interface UiBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface UiNode {
  /** Position in document order (0 = the first node under `hierarchy`). */
  i: number
  /** Index of the parent node in the list, null for a top-level window node. */
  parent: number | null
  depth: number
  class: string
  package: string
  text: string
  /** `com.example:id/accept`, or '' when the view has no id. */
  resource_id: string
  content_desc: string
  /** A text field's hint (its accessible name while empty); '' on images older than API 26 and on other views. */
  hint: string
  clickable: boolean
  /** Long-press does something (a context menu, drag, select). */
  long_clickable: boolean
  /** Can take keyboard / accessibility focus on its own. */
  focusable: boolean
  /** Scrolls (a list, a pager, a scroll view). */
  scrollable: boolean
  /** A checkbox, switch, radio button or toggle. */
  checkable: boolean
  enabled: boolean
  /** A password field (its text is never the password: Android hides it). */
  password: boolean
  /** A ticked checkbox, switch or radio button (an "I agree" box changes only this when tapped). */
  checked: boolean
  /** A selected tab, page indicator dot or list item. */
  selected: boolean
  /** Null when the dump had no parseable bounds. */
  bounds: UiBounds | null
}

export interface UiScreen {
  rotation: number
  nodes: UiNode[]
}

export class DumpError extends Error {}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]+);/g, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITY[name] ?? whole
  })
}

const BOUNDS_RE = /^\[(-?\d{1,6}),(-?\d{1,6})\]\[(-?\d{1,6}),(-?\d{1,6})\]$/

export function parseBounds(value: string): UiBounds | null {
  const m = BOUNDS_RE.exec(value)
  if (!m) return null
  const [left, top, right, bottom] = m.slice(1).map(Number)
  return right >= left && bottom >= top ? { left, top, right, bottom } : null
}

/** The center of a node, where a tap lands. */
export function center(b: UiBounds): { x: number; y: number } {
  return { x: Math.floor((b.left + b.right) / 2), y: Math.floor((b.top + b.bottom) / 2) }
}

const TAG_RE = /<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * Parse `uiautomator dump` output. Text around the XML (adb's "UI hierchary dumped to: ..." line, an XML
 * declaration) is ignored; anything else that is not the dump's own markup is a DumpError.
 */
export function parseUiDump(text: string): UiScreen {
  if (text.length > MAX_DUMP_BYTES) throw new DumpError(`the screen dump is larger than ${MAX_DUMP_BYTES / 1024 / 1024} MB`)
  const start = text.indexOf('<hierarchy')
  const end = text.lastIndexOf('</hierarchy>')
  if (start < 0) {
    const said = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    throw new DumpError(said ? `uiautomator printed no screen: ${said.slice(0, 200)}` : 'uiautomator printed nothing')
  }
  if (end < start) throw new DumpError('the screen dump is cut off (no closing </hierarchy>)')
  const xml = text.slice(start, end + '</hierarchy>'.length)

  const nodes: UiNode[] = []
  const stack: number[] = []
  let rotation = 0
  let inHierarchy = false
  let closed = false
  let pos = 0
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos)
    if (lt < 0) break
    if (xml.slice(pos, lt).trim() !== '') throw new DumpError(`unexpected text in the screen dump at offset ${pos}`)
    TAG_RE.lastIndex = lt
    const m = TAG_RE.exec(xml)
    if (!m) throw new DumpError(`malformed tag in the screen dump at offset ${lt}`)
    pos = TAG_RE.lastIndex
    const [, slash, name, attrText, selfClose] = m
    if (closed) throw new DumpError('content after </hierarchy>')
    if (name === 'hierarchy') {
      if (slash) {
        if (!inHierarchy || stack.length > 0) throw new DumpError('</hierarchy> closes an open node')
        closed = true
        continue
      }
      if (inHierarchy) throw new DumpError('nested <hierarchy>')
      inHierarchy = true
      const r = /\brotation\s*=\s*"(\d)"/.exec(attrText)
      rotation = r ? Number(r[1]) : 0
      if (selfClose) closed = true
      continue
    }
    if (name !== 'node') throw new DumpError(`unexpected element <${name}> in the screen dump`)
    if (!inHierarchy) throw new DumpError('<node> outside <hierarchy>')
    if (slash) {
      if (stack.pop() === undefined) throw new DumpError('</node> without an open node')
      continue
    }
    if (nodes.length >= MAX_NODES) throw new DumpError(`the screen has more than ${MAX_NODES} nodes`)
    if (stack.length >= MAX_DEPTH) throw new DumpError(`the screen is nested deeper than ${MAX_DEPTH} levels`)
    const attrs = new Map<string, string>()
    for (const a of attrText.matchAll(ATTR_RE)) attrs.set(a[1], decode(a[2] ?? a[3] ?? ''))
    const flag = (k: string): boolean => attrs.get(k) === 'true'
    const node: UiNode = {
      i: nodes.length,
      parent: stack.length > 0 ? stack[stack.length - 1] : null,
      depth: stack.length,
      class: attrs.get('class') ?? '',
      package: attrs.get('package') ?? '',
      text: attrs.get('text') ?? '',
      resource_id: attrs.get('resource-id') ?? '',
      content_desc: attrs.get('content-desc') ?? '',
      hint: attrs.get('hint') ?? '',
      clickable: flag('clickable'),
      long_clickable: flag('long-clickable'),
      focusable: flag('focusable'),
      scrollable: flag('scrollable'),
      checkable: flag('checkable'),
      // uiautomator always writes it; a node without it is treated as enabled, like Android's default.
      enabled: attrs.get('enabled') !== 'false',
      password: flag('password'),
      checked: flag('checked'),
      selected: flag('selected'),
      bounds: parseBounds(attrs.get('bounds') ?? '')
    }
    nodes.push(node)
    if (!selfClose) stack.push(node.i)
  }
  if (!closed) throw new DumpError('the screen dump is cut off (unclosed <hierarchy>)')
  return { rotation, nodes }
}

/**
 * The adb shell line that dumps the screen and prints it, through a temp file (`/dev/tty` is not writable on every
 * image) named by the caller so two opens on one device never share it. uiautomator's own line ("UI hierchary dumped
 * to: ...", or its error) stays in the output: parseUiDump skips the first and quotes the second. The exit status is
 * the dump's (or cat's), not the clean-up's.
 */
export function dumpLine(id: string): string {
  if (!/^[a-z0-9]{1,32}$/.test(id)) throw new Error(`"${id}" is not a dump file id.`)
  const path = `/data/local/tmp/nawi-window-${id}.xml`
  return `uiautomator dump ${path} && cat ${path}; s=$?; rm -f ${path}; exit $s`
}
