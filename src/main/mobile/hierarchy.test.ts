import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { center, DumpError, dumpLine, MAX_DEPTH, MAX_NODES, parseBounds, parseUiDump } from './hierarchy'

/**
 * The screen-dump reader (roadmap M2c, reused by M3) on real `uiautomator dump` output from an API 36 emulator
 * (fixtures/ui-dumps, captured with hierarchy.ts's DUMP_LINE) and on hostile input: the dump comes from the app under
 * test, so anything that is not uiautomator's own markup is refused with a reason, never half-parsed.
 */

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'ui-dumps', name), 'utf8')
const wrap = (inner: string): string => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="1">${inner}</hierarchy>`

describe('parseUiDump on real dumps', () => {
  it('reads the permission prompt of an API 36 emulator: every node, in document order, with parents and depths', () => {
    const screen = parseUiDump(fixture('camera-permission.txt'))
    expect(screen.rotation).toBe(0)
    expect(screen.nodes.length, 'node count of camera-permission.txt').toBe(18)
    const allow = screen.nodes.find((n) => n.resource_id === 'com.android.permissioncontroller:id/permission_allow_foreground_only_button')
    expect(allow, 'the "While using the app" button').toMatchObject({
      text: 'While using the app',
      class: 'android.widget.Button',
      package: 'com.google.android.permissioncontroller',
      clickable: true,
      enabled: true,
      password: false
    })
    expect(allow?.bounds, 'bounds of the allow button').not.toBeNull()
    for (const n of screen.nodes) {
      expect(n.parent === null ? 0 : screen.nodes[n.parent].depth + 1, `depth of node ${n.i} follows its parent`).toBe(n.depth)
      expect(n.parent === null || n.parent < n.i, `parent of node ${n.i} comes before it`).toBe(true)
    }
    const message = screen.nodes.find((n) => n.resource_id.endsWith(':id/permission_message'))
    expect(message?.text, 'curly apostrophe kept as is').toBe('Allow Camera to access this device’s location?')
  })

  it('reads the checked state of the real check box and radio button, and nothing else as checked or selected', () => {
    const intro = parseUiDump(fixture('camera-intro.txt'))
    const permission = parseUiDump(fixture('camera-permission.txt'))
    expect(intro.nodes.filter((n) => n.checked).map((n) => n.resource_id), 'checked nodes in camera-intro.txt').toEqual(['com.android.camera2:id/check_box'])
    expect(permission.nodes.filter((n) => n.checked).map((n) => n.resource_id), 'checked nodes in camera-permission.txt').toEqual([
      'com.android.permissioncontroller:id/permission_location_accuracy_radio_fine'
    ])
    expect([...intro.nodes, ...permission.nodes].filter((n) => n.selected).map((n) => n.i), 'selected nodes in both dumps').toEqual([])
  })

  it('reads the inventory flags (checkable, focusable, scrollable, long-clickable) and the hint as the dump writes them', () => {
    const box = parseUiDump(fixture('camera-intro.txt')).nodes.find((n) => n.resource_id === 'com.android.camera2:id/check_box')
    expect(box, 'the real check box').toMatchObject({ checkable: true, clickable: true, focusable: true, scrollable: false, long_clickable: false, hint: '' })
    const { nodes } = parseUiDump(wrap('<node scrollable="true" long-clickable="true" hint="Search &amp; go"/><node checkable="TRUE" focusable="1"/>'))
    expect([nodes[0].scrollable, nodes[0].long_clickable, nodes[0].hint]).toEqual([true, true, 'Search & go'])
    expect([nodes[1].checkable, nodes[1].focusable], 'only the exact value "true" sets a flag').toEqual([false, false])
  })

  it('skips the "UI hierchary dumped to" line and the XML declaration', () => {
    const screen = parseUiDump(fixture('camera-intro.txt'))
    expect(screen.nodes.map((n) => n.text).filter(Boolean)).toEqual(['Remember photo locations?', "Tag your photos and videos with the locations where they're taken.", 'NEXT'])
  })
})

describe('parseUiDump on edge cases', () => {
  it('decodes the XML entities and numeric references uiautomator writes, and nothing else', () => {
    const { nodes } = parseUiDump(wrap('<node text="Terms &amp; &lt;Privacy&gt; &quot;x&quot; &apos;y&apos; &#233; &#x1F600; &bogus;" bounds="[0,0][10,10]"/>'))
    expect(nodes[0].text).toBe(`Terms & <Privacy> "x" 'y' é 😀 &bogus;`)
  })

  it('reads rotation, missing attributes as empty / false / enabled, and bad bounds as null', () => {
    const { rotation, nodes } = parseUiDump(wrap('<node class="a.B"/><node enabled="false" bounds="[5,5][1,1]"/>'))
    expect(rotation).toBe(1)
    expect(nodes[0]).toEqual({ i: 0, parent: null, depth: 0, class: 'a.B', package: '', text: '', resource_id: '', content_desc: '', hint: '', clickable: false, long_clickable: false, focusable: false, scrollable: false, checkable: false, enabled: true, password: false, checked: false, selected: false, bounds: null })
    expect(nodes[1].enabled).toBe(false)
    const flags = parseUiDump(wrap('<node checked="true" selected="true"/><node checked="false" selected="TRUE"/>')).nodes
    expect(flags.map((n) => [n.checked, n.selected]), 'only the exact value "true" sets checked/selected').toEqual([[true, true], [false, false]])
    expect(nodes[1].bounds, 'right < left is not a box').toBeNull()
  })

  it.each([
    ['nothing', '', /printed nothing/],
    ["uiautomator's idle error", 'ERROR: could not get idle state.\n', /printed no screen: ERROR: could not get idle state\./],
    ['a cut-off dump', '<hierarchy rotation="0"><node text="a">', /cut off/],
    ['an unclosed node', wrap('<node text="a">'), /closes an open node/],
    ['a stray closing node', wrap('<node/></node>'), /without an open node/],
    ['another element', wrap('<script>x</script>'), /unexpected element <script>/],
    ['text between tags', wrap('<node/>hello<node/>'), /unexpected text/],
    ['a malformed tag', wrap('<node text=unquoted/>'), /malformed tag/],
    ['content after the end', `${wrap('')}<node/></hierarchy>`, /content after <\/hierarchy>|closes an open node/],
    ['a nested hierarchy', wrap('<hierarchy></hierarchy>'), /nested <hierarchy>|content after/]
  ])('refuses %s with a reason', (_what, text, message) => {
    expect(() => parseUiDump(text)).toThrow(DumpError)
    expect(() => parseUiDump(text)).toThrow(message)
  })

  it('caps the node count and the depth', () => {
    expect(() => parseUiDump(wrap('<node/>'.repeat(MAX_NODES + 1)))).toThrow(`more than ${MAX_NODES} nodes`)
    expect(() => parseUiDump(wrap(`${'<node>'.repeat(MAX_DEPTH + 1)}${'</node>'.repeat(MAX_DEPTH + 1)}`))).toThrow(`deeper than ${MAX_DEPTH}`)
    expect(parseUiDump(wrap(`${'<node>'.repeat(MAX_DEPTH)}${'</node>'.repeat(MAX_DEPTH)}`)).nodes.at(-1)?.depth).toBe(MAX_DEPTH - 1)
  })
})

describe('dumpLine', () => {
  it("dumps to the caller's own temp file, prints it, removes it, and exits with the dump's status", () => {
    expect(dumpLine('a1b2')).toBe('uiautomator dump /data/local/tmp/nawi-window-a1b2.xml && cat /data/local/tmp/nawi-window-a1b2.xml; s=$?; rm -f /data/local/tmp/nawi-window-a1b2.xml; exit $s')
  })

  it.each(['', 'A1', '../x', 'a b', 'a;rm', 'x'.repeat(33)])('refuses the file id %j', (id) => {
    expect(() => dumpLine(id)).toThrow('is not a dump file id')
  })
})

describe('bounds', () => {
  it('parses [l,t][r,b] and finds the tap point', () => {
    expect(parseBounds('[351,2227][729,2353]')).toEqual({ left: 351, top: 2227, right: 729, bottom: 2353 })
    expect(center({ left: 351, top: 2227, right: 729, bottom: 2353 })).toEqual({ x: 540, y: 2290 })
    expect(parseBounds('[1,2][3]')).toBeNull()
    expect(parseBounds('')).toBeNull()
  })
})
