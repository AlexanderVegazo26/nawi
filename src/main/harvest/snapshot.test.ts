import { describe, expect, it } from 'vitest'
import {
  boundsByBackendNodeId,
  buildAxTree,
  filterSecretsFromSnapshot,
  SNAPSHOT_SENTINEL,
  type CapturedSnapshot
} from './snapshot'

/**
 * Modelled on a snapshot dumped from a real Chromium against the project
 * fixture, including the detail that makes the naive fix wrong: the password
 * string is interned once (index 4) and referenced from **both** the `value`
 * attribute and `inputValue`.
 */
function fixtureSnapshot(): CapturedSnapshot {
  return {
    strings: [
      'input', // 0  nodeName
      'type', // 1  attr name, shared by both inputs
      'password', // 2  attr value, shared by both inputs
      'value', // 3  attr name, shared by both inputs
      'hunter2-secret', // 4  THE SECRET — shared by the attribute AND inputValue
      'Save', // 5  text of a node OUTSIDE the secret subtree
      'div', // 6
      'not-secret-value', // 7  the non-secret input's value
      'secret-inner-text' // 8  text INSIDE the secret subtree
    ],
    documents: [
      {
        nodes: {
          //          0=root  1=secret input  2=plain input  3=text in secret  4=plain div
          parentIndex: [-1, 0, 0, 1, 0],
          backendNodeId: [10, 11, 12, 13, 14],
          nodeName: [6, 0, 0, 6, 6],
          nodeValue: [-1, -1, -1, 8, 5],
          attributes: [[], [1, 2, 3, 4], [1, 2, 3, 7], [], []],
          inputValue: { index: [1, 2], value: [4, 7] }
        },
        layout: {
          nodeIndex: [0, 1, 2],
          bounds: [
            [0, 0, 800, 600],
            [10, 20, 200, 30],
            [10, 60, 200, 30]
          ],
          text: [-1, -1, -1],
          styles: [[], [], []]
        }
      }
    ]
  }
}

/** The filter appends its sentinel, so it lands at the original table length. */
const SENTINEL_INDEX = 9

describe('filterSecretsFromSnapshot — Tier A for FR-STA.1', () => {
  it('removes the secret from the string table entirely, not just from one reference', () => {
    const { snapshot } = filterSecretsFromSnapshot(fixtureSnapshot(), [11])
    // The whole point: a byte scan of the serialized snapshot finds nothing.
    expect(JSON.stringify(snapshot)).not.toContain('hunter2-secret')
    expect(snapshot.strings).not.toContain('hunter2-secret')
  })

  it('redirects both the attribute value and the inputValue reference', () => {
    const { snapshot, redirected } = filterSecretsFromSnapshot(fixtureSnapshot(), [11])
    const doc = snapshot.documents![0]!
    // The sentinel is APPENDED, so its index is the original table length.
    // `indexOf` would be ambiguous: blanked entries carry the same text.
    expect(snapshot.strings![SENTINEL_INDEX]).toBe(SNAPSHOT_SENTINEL)
    expect(doc.nodes!.attributes![1]![3]).toBe(SENTINEL_INDEX)
    expect(doc.nodes!.inputValue!.value![0]).toBe(SENTINEL_INDEX)
    expect(redirected).toBeGreaterThanOrEqual(2)
  })

  it('leaves a non-secret sibling node untouched', () => {
    const { snapshot } = filterSecretsFromSnapshot(fixtureSnapshot(), [11])
    expect(JSON.stringify(snapshot)).toContain('not-secret-value')
    const doc = snapshot.documents![0]!
    expect(doc.nodes!.inputValue!.value![1]).toBe(7)
  })

  it('does not destroy a shared string that a non-secret node still references', () => {
    // `password` (index 2) and `type` (index 1) are referenced by BOTH inputs.
    // Blanking by "was referenced by a secret node" alone would wreck them.
    const { snapshot } = filterSecretsFromSnapshot(fixtureSnapshot(), [11])
    expect(snapshot.strings![1]).toBe('type')
    expect(snapshot.strings![2]).toBe('password')
  })

  it('preserves an unrelated text node (guards against over-blanking)', () => {
    const { snapshot } = filterSecretsFromSnapshot(fixtureSnapshot(), [11])
    expect(snapshot.strings![5]).toBe('Save')
  })

  it('does not renumber nodes: the arrays keep their length and parent links', () => {
    const before = fixtureSnapshot()
    const { snapshot } = filterSecretsFromSnapshot(before, [11])
    const doc = snapshot.documents![0]!
    expect(doc.nodes!.parentIndex).toEqual(before.documents![0]!.nodes!.parentIndex)
    expect(doc.nodes!.backendNodeId).toHaveLength(5)
    expect(doc.layout!.nodeIndex).toEqual([0, 1, 2])
  })

  it('covers descendants of a secret node', () => {
    // Node 3's parent is node 1, which is secret; its text must go too.
    const { snapshot } = filterSecretsFromSnapshot(fixtureSnapshot(), [11])
    const doc = snapshot.documents![0]!
    expect(doc.nodes!.nodeValue![3]).toBe(SENTINEL_INDEX)
    // …and its now-unreferenced string is gone from the table too.
    expect(snapshot.strings).not.toContain('secret-inner-text')
  })

  it('does not mutate the caller’s snapshot object', () => {
    const original = fixtureSnapshot()
    filterSecretsFromSnapshot(original, [11])
    expect(original.strings).toContain('hunter2-secret')
  })

  it('reports secret ids that were not present in the snapshot', () => {
    const { unmatched } = filterSecretsFromSnapshot(fixtureSnapshot(), [11, 999])
    expect(unmatched).toEqual([999])
  })

  it('is a no-op on an empty secret set, and does not pretend otherwise', () => {
    const { snapshot, redirected } = filterSecretsFromSnapshot(fixtureSnapshot(), [])
    expect(redirected).toBe(0)
    expect(JSON.stringify(snapshot)).toContain('hunter2-secret')
  })
})

describe('boundsByBackendNodeId / buildAxTree — FR-STA.2', () => {
  it('joins AX nodes to snapshot layout rects', () => {
    const bounds = boundsByBackendNodeId(fixtureSnapshot())
    expect(bounds.get(11)).toEqual([10, 20, 200, 30])
    expect(bounds.get(12)).toEqual([10, 60, 200, 30])
    // Node 13 has no layout box; it must be absent, not zeroed.
    expect(bounds.has(13)).toBe(false)
  })

  it('carries role, name and joined bounds onto the AX output', () => {
    const tree = buildAxTree(
      [
        {
          nodeId: '1',
          ignored: false,
          role: { value: 'button' },
          name: { value: 'Save' },
          backendDOMNodeId: 12,
          childIds: ['2']
        }
      ],
      fixtureSnapshot(),
      []
    )
    expect(tree[0]).toMatchObject({
      node_id: '1',
      role: 'button',
      name: 'Save',
      bounds: [10, 60, 200, 30],
      child_ids: ['2']
    })
  })

  it('suppresses name and value on a secret node unconditionally', () => {
    const tree = buildAxTree(
      [
        {
          nodeId: '1',
          role: { value: 'textbox' },
          name: { value: 'Password' },
          value: { value: 'hunter2-secret' },
          backendDOMNodeId: 11
        }
      ],
      fixtureSnapshot(),
      [11]
    )
    expect(tree[0]!.value).toBeNull()
    expect(tree[0]!.name).toBeNull()
    // The node still exists — suppression is targeted, not deletion.
    expect(tree[0]!.role).toBe('textbox')
    expect(JSON.stringify(tree)).not.toContain('hunter2-secret')
  })

  /**
   * Both of these were found by the release gate against a real Chromium, on a
   * `type="text"` field carrying `autocomplete="one-time-code"` — which, unlike
   * a password field, Chromium does not mask.
   */
  it('suppresses AX properties on a secret node, not just name and value', () => {
    const tree = buildAxTree(
      [
        {
          nodeId: '1',
          role: { value: 'textbox' },
          backendDOMNodeId: 11,
          properties: [
            { name: 'value', value: { value: 'hunter2-secret' } },
            { name: 'required', value: { value: true } }
          ]
        }
      ],
      fixtureSnapshot(),
      [11]
    )
    expect(JSON.stringify(tree)).not.toContain('hunter2-secret')
    expect(tree[0]!.states).toEqual({})
  })

  it('descends the AX tree: a child of a secret node is secret too', () => {
    // `markSecrets` stamps elements, and DOM.querySelectorAll returns only
    // elements — so the static-text child carrying the typed value is never in
    // the marked set. Checking each node's own backendDOMNodeId lets it through.
    const tree = buildAxTree(
      [
        { nodeId: '1', role: { value: 'textbox' }, backendDOMNodeId: 11, childIds: ['2'] },
        {
          nodeId: '2',
          role: { value: 'StaticText' },
          name: { value: 'hunter2-secret' },
          parentId: '1',
          backendDOMNodeId: 99
        }
      ],
      fixtureSnapshot(),
      [11]
    )
    expect(JSON.stringify(tree)).not.toContain('hunter2-secret')
    expect(tree[1]!.name).toBeNull()
    // The structure survives; only the content is gone.
    expect(tree[1]!.role).toBe('StaticText')
  })

  it('descends even when a child is emitted before its parent', () => {
    const tree = buildAxTree(
      [
        { nodeId: '2', name: { value: 'hunter2-secret' }, parentId: '1', backendDOMNodeId: 99 },
        { nodeId: '1', backendDOMNodeId: 11, childIds: ['2'] }
      ],
      fixtureSnapshot(),
      [11]
    )
    expect(JSON.stringify(tree)).not.toContain('hunter2-secret')
  })

  it('leaves properties on a NON-secret node intact', () => {
    const tree = buildAxTree(
      [{ nodeId: '1', backendDOMNodeId: 12, properties: [{ name: 'required', value: { value: true } }] }],
      fixtureSnapshot(),
      [11]
    )
    expect(tree[0]!.states).toEqual({ required: 'true' })
  })

  it('yields null bounds rather than a guess when there is no snapshot', () => {
    const tree = buildAxTree([{ nodeId: '1', backendDOMNodeId: 11 }], null, [])
    expect(tree[0]!.bounds).toBeNull()
  })

  it('flattens AX properties into states', () => {
    const tree = buildAxTree(
      [{ nodeId: '1', backendDOMNodeId: 12, properties: [{ name: 'disabled', value: { value: true } }] }],
      fixtureSnapshot(),
      []
    )
    expect(tree[0]!.states).toEqual({ disabled: 'true' })
  })
})
