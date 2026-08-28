/**
 * Tier A for FR-STA.1 — filtering secret values out of a `DOMSnapshot` before
 * it can enter a draft, and joining `Accessibility.getFullAXTree` nodes to the
 * snapshot's layout rects for FR-STA.2's bounds.
 *
 * **The shapes here were read off a real Chromium, not off memory.** The
 * relevant encoding, confirmed against a live capture of the project fixture:
 *
 * ```jsonc
 * documents[0].nodes = {
 *   parentIndex:   number[],              // parallel to every node array
 *   backendNodeId: number[],              //  "
 *   nodeName:      number[],              // string-table indices
 *   nodeValue:     number[],              // string-table index, -1 for none
 *   attributes:    number[][],            // flat [nameIdx, valueIdx, …] per node
 *   inputValue:  { index: number[],       // node indices …
 *                  value: number[] },     // … and their string-table indices
 *   textValue:   { index, value },        // same "RareStringData" shape
 * }
 * documents[0].layout = { nodeIndex: number[], bounds: number[][], text: number[], … }
 * strings = string[]                      // one table, shared by every document
 * ```
 *
 * **Why nodes are not removed.** Deleting entries from these arrays reindexes
 * everything that points into them — `parentIndex`, `layout.nodeIndex`,
 * `textValue.index`, and every rare-data `index` array. A filter that
 * renumbered them would corrupt the snapshot in ways nothing would notice. So
 * the node stays and its *string references* are redirected instead.
 *
 * **Why redirection alone is not enough.** The string table interns: on the
 * fixture, `strings[48]` is `"hunter2-must-never-leave-the-page"` and it is
 * pointed at from *both* the `value="…"` attribute and `inputValue`. Redirecting
 * one reference leaves the other, and redirecting both still leaves the literal
 * bytes sitting in `strings[48]` for anyone who opens the file. So there are two
 * mechanisms: redirect every reference held by a secret node, then blank any
 * table entry that is unreferenced *afterwards*, computed across every field of
 * every document. The "afterwards" is what keeps shared strings like the `type`
 * attribute's `"password"` from being blanked while something still points at
 * them.
 */

export const SNAPSHOT_SENTINEL = '[REDACTED:secret-field]'

/** CDP's `RareStringData` / `RareIntegerData` shape. */
interface RareData {
  index?: number[]
  value?: number[]
}

interface SnapshotNodes {
  parentIndex?: number[]
  backendNodeId?: number[]
  nodeName?: number[]
  nodeValue?: number[]
  attributes?: number[][]
  textValue?: RareData
  inputValue?: RareData
  currentSourceURL?: RareData
  originURL?: RareData
  pseudoIdentifier?: RareData
  shadowRootType?: RareData
  [key: string]: unknown
}

interface SnapshotLayout {
  nodeIndex?: number[]
  bounds?: number[][]
  text?: number[]
  styles?: number[][]
  [key: string]: unknown
}

interface SnapshotDocument {
  nodes?: SnapshotNodes
  layout?: SnapshotLayout
  [key: string]: unknown
}

export interface CapturedSnapshot {
  documents?: SnapshotDocument[]
  strings?: string[]
  [key: string]: unknown
}

export interface SnapshotFilterResult {
  snapshot: CapturedSnapshot
  /** Node references redirected to the sentinel. */
  redirected: number
  /** String-table entries blanked because nothing referenced them any more. */
  blanked: number
  /** Secret backendNodeIds that were not present in the snapshot at all. */
  unmatched: number[]
}

/** Every field of `nodes`/`layout` that can hold a string-table index. */
function collectReferencedStringIndices(doc: SnapshotDocument, into: Set<number>): void {
  const nodes = doc.nodes ?? {}
  const layout = doc.layout ?? {}

  const addAll = (values: number[] | undefined): void => {
    for (const v of values ?? []) if (v >= 0) into.add(v)
  }

  addAll(nodes.nodeName)
  addAll(nodes.nodeValue)
  for (const attrs of nodes.attributes ?? []) addAll(attrs)
  for (const rare of [
    nodes.textValue,
    nodes.inputValue,
    nodes.currentSourceURL,
    nodes.originURL,
    nodes.pseudoIdentifier,
    nodes.shadowRootType
  ]) {
    addAll(rare?.value)
  }
  addAll(layout.text)
  for (const styles of layout.styles ?? []) addAll(styles)
}

/**
 * Redirect a secret node's string references to the sentinel, then blank any
 * table entry left unreferenced.
 *
 * `secretBackendNodeIds` comes from `markAndResolveSecrets`, in the round trip
 * that *precedes* `captureSnapshot`. Calling this with an empty set is a no-op
 * and, importantly, is not treated as success by anything: the caller is
 * expected to notice that no ids were resolved.
 */
export function filterSecretsFromSnapshot(
  snapshot: CapturedSnapshot,
  secretBackendNodeIds: readonly number[]
): SnapshotFilterResult {
  // Structured clone: the caller's object is CDP's reply and may be logged or
  // asserted on elsewhere. Mutating it in place is how a "filtered" snapshot and
  // an unfiltered one become the same object.
  const out = JSON.parse(JSON.stringify(snapshot)) as CapturedSnapshot
  const strings = out.strings ?? []
  const secretIds = new Set(secretBackendNodeIds)
  const matched = new Set<number>()

  const sentinelIndex = strings.length
  strings.push(SNAPSHOT_SENTINEL)
  out.strings = strings

  let redirected = 0

  for (const doc of out.documents ?? []) {
    const nodes = doc.nodes
    if (!nodes) continue
    const backendIds = nodes.backendNodeId ?? []

    // Node indices that are secret, plus their descendants. `markSecrets`
    // already stamps the subtree, so the parentIndex closure is a second line of
    // defence rather than the mechanism — but a subtree added between marking
    // and capture would otherwise slip through.
    const secretNodeIndices = new Set<number>()
    for (let i = 0; i < backendIds.length; i++) {
      const id = backendIds[i]
      if (id !== undefined && secretIds.has(id)) {
        secretNodeIndices.add(i)
        matched.add(id)
      }
    }
    const parents = nodes.parentIndex ?? []
    // One forward pass suffices: CDP emits nodes in document order, so a parent
    // always precedes its children.
    for (let i = 0; i < parents.length; i++) {
      const parent = parents[i]
      if (parent !== undefined && parent >= 0 && secretNodeIndices.has(parent)) {
        secretNodeIndices.add(i)
      }
    }

    if (secretNodeIndices.size === 0) continue

    // `nodeValue` — text content of a text node inside a secret subtree.
    const nodeValue = nodes.nodeValue
    if (nodeValue) {
      for (const i of secretNodeIndices) {
        if (nodeValue[i] !== undefined && nodeValue[i]! >= 0) {
          nodeValue[i] = sentinelIndex
          redirected++
        }
      }
    }

    // Attribute *values* only. Blanking the names would strip `type`/`id` from
    // the element and make the snapshot structurally wrong for no gain.
    const attributes = nodes.attributes
    if (attributes) {
      for (const i of secretNodeIndices) {
        const attrs = attributes[i]
        if (!attrs) continue
        for (let k = 1; k < attrs.length; k += 2) {
          if (attrs[k]! >= 0) {
            attrs[k] = sentinelIndex
            redirected++
          }
        }
      }
    }

    for (const rare of [nodes.textValue, nodes.inputValue, nodes.currentSourceURL, nodes.originURL]) {
      if (!rare?.index || !rare.value) continue
      for (let k = 0; k < rare.index.length; k++) {
        if (secretNodeIndices.has(rare.index[k]!)) {
          rare.value[k] = sentinelIndex
          redirected++
        }
      }
    }
  }

  // Second mechanism: anything now unreferenced is blanked in place. Indices
  // must stay stable, so entries are overwritten rather than removed.
  const referenced = new Set<number>()
  for (const doc of out.documents ?? []) collectReferencedStringIndices(doc, referenced)

  let blanked = 0
  for (let i = 0; i < strings.length; i++) {
    if (i === sentinelIndex) continue
    if (!referenced.has(i) && strings[i] !== '') {
      strings[i] = SNAPSHOT_SENTINEL
      blanked++
    }
  }

  return {
    snapshot: out,
    redirected,
    blanked,
    unmatched: [...secretIds].filter((id) => !matched.has(id))
  }
}

/* ------------------------------------------------------------------ *
 * FR-STA.2 — accessibility tree with bounds
 * ------------------------------------------------------------------ */

export interface AxNodeOut {
  node_id: string
  backend_node_id: number | null
  ignored: boolean
  role: string | null
  name: string | null
  value: string | null
  states: Record<string, string>
  bounds: [number, number, number, number] | null
  parent_id: string | null
  child_ids: string[]
}

interface RawAxValue {
  value?: unknown
}

interface RawAxNode {
  nodeId?: string
  ignored?: boolean
  role?: RawAxValue
  name?: RawAxValue
  value?: RawAxValue
  properties?: Array<{ name?: string; value?: RawAxValue }>
  parentId?: string
  childIds?: string[]
  backendDOMNodeId?: number
}

function stringOf(v: RawAxValue | undefined): string | null {
  if (!v || v.value === undefined || v.value === null) return null
  return typeof v.value === 'string' ? v.value : String(v.value)
}

/**
 * `backendNodeId` → layout bounds, built from the snapshot.
 *
 * The join is two hops: `backendNodeId` gives a node index (position in
 * `nodes.backendNodeId`), and `layout.nodeIndex[k] === thatIndex` gives the
 * `layout.bounds[k]` rect. A node with no layout box (`display:none`, a text
 * node) simply has no entry, which is why the result is a map and the AX bounds
 * are nullable.
 */
export function boundsByBackendNodeId(
  snapshot: CapturedSnapshot
): Map<number, [number, number, number, number]> {
  const map = new Map<number, [number, number, number, number]>()
  for (const doc of snapshot.documents ?? []) {
    const backendIds = doc.nodes?.backendNodeId ?? []
    const nodeIndex = doc.layout?.nodeIndex ?? []
    const bounds = doc.layout?.bounds ?? []
    for (let k = 0; k < nodeIndex.length; k++) {
      const idx = nodeIndex[k]
      const rect = bounds[k]
      if (idx === undefined || !rect || rect.length < 4) continue
      const backendId = backendIds[idx]
      if (backendId === undefined) continue
      if (!map.has(backendId)) {
        map.set(backendId, [rect[0]!, rect[1]!, rect[2]!, rect[3]!])
      }
    }
  }
  return map
}

/**
 * Every AX node that is secret: those sitting directly on a marked element,
 * **plus their descendants**.
 *
 * The descent is not optional, and the release gate proved it. `markSecrets`
 * stamps *elements*, and `DOM.querySelectorAll` returns only elements — so a
 * field's AX subtree (the static-text child that carries the typed value for a
 * `type="text"` field) is never in the marked set, and a check against the
 * node's own `backendDOMNodeId` alone lets the value straight through.
 */
function secretAxNodeIds(
  nodes: readonly RawAxNode[],
  secretBackendNodeIds: readonly number[]
): Set<string> {
  const secretBackend = new Set(secretBackendNodeIds)
  const childIds = new Map<string, string[]>()
  const secret = new Set<string>()

  for (const node of nodes) {
    if (typeof node.nodeId !== 'string') continue
    childIds.set(node.nodeId, (node.childIds ?? []).filter((c) => typeof c === 'string'))
    if (typeof node.backendDOMNodeId === 'number' && secretBackend.has(node.backendDOMNodeId)) {
      secret.add(node.nodeId)
    }
  }

  // Breadth-first from every secret root. The AX tree is not guaranteed to be
  // emitted parent-before-child, so a single forward pass is not enough here.
  const queue = [...secret]
  while (queue.length > 0) {
    for (const child of childIds.get(queue.pop()!) ?? []) {
      if (!secret.has(child)) {
        secret.add(child)
        queue.push(child)
      }
    }
  }
  return secret
}

/**
 * Normalize an AX tree, joining bounds and suppressing everything text-bearing
 * on any node that sits on — or inside — a secret element.
 *
 * Chromium usually reports a *password* field's AX value as a masked string,
 * but "usually" is not a security control, and it does no masking at all for a
 * `type="text"` field carrying `autocomplete="one-time-code"`. So suppression
 * here is unconditional and covers `name`, `value` and the flattened
 * `properties` alike: FR-SEC.2 says "never recorded in the state layer, in any
 * form", and an AX property is a form.
 */
export function buildAxTree(
  rawNodes: readonly unknown[],
  snapshot: CapturedSnapshot | null,
  secretBackendNodeIds: readonly number[]
): AxNodeOut[] {
  const bounds = snapshot ? boundsByBackendNodeId(snapshot) : new Map()
  const nodes = rawNodes as RawAxNode[]
  const secret = secretAxNodeIds(nodes, secretBackendNodeIds)
  const out: AxNodeOut[] = []

  for (const node of nodes) {
    if (typeof node.nodeId !== 'string') continue
    const backendId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : null
    const isSecret = secret.has(node.nodeId)

    // Dropped wholesale on a secret node rather than filtered by property name:
    // an allowlist would have to be right about every current and future AX
    // property, and being wrong once is a leak.
    const states: Record<string, string> = {}
    if (!isSecret) {
      for (const prop of node.properties ?? []) {
        if (typeof prop.name !== 'string') continue
        const value = stringOf(prop.value)
        if (value !== null) states[prop.name] = value
      }
    }

    out.push({
      node_id: node.nodeId,
      backend_node_id: backendId,
      ignored: node.ignored === true,
      // The role is a structural fact, not content, and it is what makes the
      // suppressed node still useful to an agent.
      role: stringOf(node.role),
      name: isSecret ? null : stringOf(node.name),
      value: isSecret ? null : stringOf(node.value),
      states,
      bounds: backendId !== null ? (bounds.get(backendId) ?? null) : null,
      parent_id: typeof node.parentId === 'string' ? node.parentId : null,
      child_ids: Array.isArray(node.childIds) ? node.childIds.filter((c) => typeof c === 'string') : []
    })
  }
  return out
}
