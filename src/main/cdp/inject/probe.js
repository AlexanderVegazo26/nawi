/**
 * Nawi page-side probe.
 *
 * Injected with `Page.addScriptToEvaluateOnNewDocument` so it is present before
 * any page script runs. Two jobs, both of which *must* happen in the page:
 *
 *  1. **FR-STA.6 selector descriptors.** Uniqueness is
 *     `document.querySelectorAll(sel).length === 1` — it needs the live DOM, and
 *     it cannot be recovered from a serialized snapshot after the fact. Scoring
 *     itself is not done here; it happens in `selectors.ts`, where it is
 *     testable. This file emits facts, not ranks.
 *
 *  2. **FR-SEC.2 secret suppression.** The value of a password / one-time-code /
 *     configured-secret field is **never put into a message at all**, so it
 *     never crosses the CDP wire. Suppression here rather than after receipt is
 *     the whole point: a value that reaches the main process has already been
 *     written to a socket buffer, and "we deleted it afterwards" is not what
 *     FR-SEC.2 asks for.
 *
 * Plain ES5-ish JS with no imports: it is stringified and evaluated in an
 * arbitrary page, which may have any (or no) module support and may have
 * clobbered globals.
 */
;(function () {
  'use strict'

  if (window.__nawiProbe) return

  var CONFIG = window.__NAWI_PROBE_CONFIG__ || {}
  /** Workspace-configured secret selectors (FR-SEC.2). */
  var SECRET_SELECTORS = Array.isArray(CONFIG.secretSelectors) ? CONFIG.secretSelectors : []
  /**
   * Our own marker. Distinct from the author-facing `data-nawi-secret`
   * opt-in, which we must not overwrite or confuse with our own bookkeeping.
   */
  var MARKER = 'data-nawi-secret-target'

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) {
      return '\\' + ch
    })
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1
    } catch (e) {
      return false
    }
  }

  function classListOf(el) {
    var out = []
    if (!el.classList) return out
    for (var i = 0; i < el.classList.length; i++) out.push(el.classList[i])
    return out
  }

  /** Position among same-tag siblings, 1-based, as `:nth-of-type` wants. */
  function nthOfType(el) {
    var index = 1
    var sibling = el.previousElementSibling
    while (sibling) {
      if (sibling.tagName === el.tagName) index++
      sibling = sibling.previousElementSibling
    }
    return index
  }

  /** A short ancestor-scoped path, stopping at the nearest stable anchor. */
  function scopedCssPath(el) {
    var parts = []
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 5) {
      var tag = node.tagName.toLowerCase()
      // An id anchors the path on this node's own segment (`section#main`), never as
      // a separate parent segment: `#main > section` would select a child of #main.
      if (node.id && !/\s/.test(node.id)) {
        parts.unshift(tag + '#' + cssEscape(node.id))
        break
      }
      var classes = classListOf(node)
      parts.unshift(classes.length ? tag + '.' + cssEscape(classes[0]) : tag)
      node = node.parentElement
      depth++
    }
    return parts.join(' > ')
  }

  function nthChildPath(el) {
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + nthOfType(node) + ')')
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  /**
   * Accessible name, approximated. The authoritative name comes from
   * `Accessibility.getFullAXTree` on the main side; this is only good enough to
   * form a `role+name` candidate and to check its uniqueness cheaply.
   */
  function accessibleName(el) {
    var label = el.getAttribute && el.getAttribute('aria-label')
    if (label) return label.trim()
    var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby')
    if (labelledBy) {
      // An id list, joined in order; ids with no element are skipped. Any referenced
      // element carrying a secret gives no name at all, not one stitched around it (FR-SEC.2).
      var ids = labelledBy.trim().split(/\s+/)
      var parts = []
      var found = false
      for (var i = 0; i < ids.length; i++) {
        var ref = ids[i] ? document.getElementById(ids[i]) : null
        if (!ref) continue
        found = true
        if (isSecret(ref) || containsSecret(ref)) return ''
        var part = shownText(ref)
        if (part) parts.push(part)
      }
      if (found) return parts.join(' ')
    }
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (el.labels && el.labels.length) return shownText(el.labels[0])
      var placeholder = el.getAttribute('placeholder')
      if (placeholder) return placeholder.trim()
    }
    return shownText(el).slice(0, 120)
  }

  /**
   * An element's text for a name, or '' when that text would carry a secret
   * (FR-SEC.2): the element is secret, or holds a secret element, such as
   * `<button>Pay <span data-nawi-secret>card-ending-4111</span></button>`. The
   * name goes into the recording as `target_name` and the role+name selector.
   */
  function shownText(node) {
    var text = (node.textContent || '').trim()
    if (!text) return ''
    return isSecret(node) || containsSecret(node) ? '' : text
  }

  var IMPLICIT_ROLES = {
    BUTTON: 'button',
    A: 'link',
    SELECT: 'combobox',
    TEXTAREA: 'textbox',
    IMG: 'img',
    H1: 'heading',
    H2: 'heading',
    H3: 'heading'
  }

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role')
    if (explicit) return explicit.trim()
    if (el.tagName === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
      if (type === 'password') return 'textbox'
      return 'textbox'
    }
    return IMPLICIT_ROLES[el.tagName] || ''
  }

  /** Longest visible text recorded as a `text` candidate: a label, not a paragraph. */
  var TEXT_CANDIDATE_MAX_CHARS = 80
  var NO_TEXT_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TITLE: 1, HEAD: 1 }
  /** Form controls and their parts: what they show is a value, and role + name already covers them. */
  var EDITABLE_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, OPTGROUP: 1, DATALIST: 1 }

  function foldSpace(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  }

  function isVisible(el) {
    if (!el.isConnected) return false
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false
    var r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  /**
   * `{ text }` locators (roadmap AI1): the innermost visible elements whose
   * rendered text (`innerText`: what is on screen, so `<br>` is a space, CSS
   * `text-transform` applies and hidden children don't count), whitespace runs
   * folded, is exactly the wanted text. Hidden elements go first (a collapsed
   * menu's copy is not visible text and must not make the locator ambiguous),
   * then any element that contains another visible match (the wrappers around
   * the button). Form-control values are not text: role + name covers those.
   * The recorder's text candidates and the replayer (replay.js `matchesFor`)
   * both use this one function, so a recorded text locator resolves the way it
   * was measured.
   */
  function textMatches(wanted) {
    var want = foldSpace(wanted)
    var body = document.body
    if (!want || !body) return []
    // Cheap bounds on the raw textContent before the costly innerText: a match
    // has at least the wanted characters, and a wrapper with far more text than
    // that (a list, the page) cannot render as exactly that text.
    var minChars = want.replace(/ /g, '').length
    var maxChars = want.length * 4 + 2000
    var all = body.querySelectorAll('*')
    var hits = []
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (NO_TEXT_TAGS[el.tagName]) continue
      var raw = el.textContent
      if (raw == null || raw.length < minChars || raw.length > maxChars) continue
      if (foldSpace(el.innerText == null ? raw : el.innerText) !== want) continue
      if (!isVisible(el)) continue
      hits.push(el)
    }
    var out = []
    for (var j = 0; j < hits.length; j++) {
      var inner = true
      for (var k = 0; k < hits.length; k++) {
        if (k !== j && hits[j].contains(hits[k])) {
          inner = false
          break
        }
      }
      if (inner) out.push(hits[j])
    }
    return out
  }

  /** A secret field or secret-marked element anywhere inside `el` (its text would carry the secret). */
  function containsSecret(el) {
    var found = false
    eachElement(
      el,
      function (d) {
        if (!found && (d.hasAttribute(MARKER) || isSecretElement(d))) found = true
      },
      0
    )
    return found
  }

  /**
   * Roadmap AI1: the element's short visible text as a locator layer, or null.
   * Only recorded when the replayer would find exactly this element by it (the
   * innermost visible element showing that text: for `<a><span>Open</span></a>`
   * that is the span, which is also what a click on the text targets). Never
   * for form controls or editable content (what they show is user input),
   * never for anything secret or holding a secret, and never for text without
   * a letter (counters, prices and glyphs change or repeat). The text is page
   * content of the same kind as the role+name candidate's accessible name.
   * Cheap checks first: this runs in the capture-phase click/key listener.
   */
  function textCandidate(el) {
    if (EDITABLE_TAGS[el.tagName] || el.isContentEditable || NO_TEXT_TAGS[el.tagName]) return null
    var raw = el.textContent
    // A label's textContent can't be far longer than its folded text (same bound as textMatches).
    if (raw == null || !/\S/.test(raw) || raw.length > TEXT_CANDIDATE_MAX_CHARS * 4 + 2000) return null
    var text = foldSpace(el.innerText == null ? raw : el.innerText)
    if (!text || text.length > TEXT_CANDIDATE_MAX_CHARS || !/\p{L}/u.test(text)) return null
    if (el.closest && el.closest('select, datalist')) return null
    if (isSecret(el) || containsSecret(el)) return null
    var hits = textMatches(text)
    if (hits.length !== 1 || hits[0] !== el) return null
    return { strategy: 'text', selector: text, unique: true }
  }

  /**
   * FR-STA.6 candidates. Every entry carries its own uniqueness, measured now,
   * against this document.
   */
  function describeSelectors(el) {
    if (!el || el.nodeType !== 1) return []
    var candidates = []

    var testIdAttrs = ['data-testid', 'data-test-id', 'data-test', 'data-qa']
    for (var i = 0; i < testIdAttrs.length; i++) {
      var attr = testIdAttrs[i]
      var value = el.getAttribute(attr)
      if (value) {
        var sel = '[' + attr + '="' + value.replace(/"/g, '\\"') + '"]'
        candidates.push({ strategy: 'testid', selector: sel, unique: isUnique(sel) })
      }
    }

    if (el.id && !/\s/.test(el.id)) {
      var idSel = '#' + cssEscape(el.id)
      candidates.push({ strategy: 'id', selector: idSel, unique: isUnique(idSel), id: el.id })
    }

    var role = roleOf(el)
    var name = accessibleName(el)
    if (role && name) {
      // Not a CSS selector: a role+name locator the consumer resolves against
      // the AX tree. Uniqueness is approximated by counting same-role elements
      // whose accessible name matches.
      var sameRole = document.querySelectorAll('*')
      var matches = 0
      for (var j = 0; j < sameRole.length && matches < 2; j++) {
        if (roleOf(sameRole[j]) === role && accessibleName(sameRole[j]) === name) matches++
      }
      candidates.push({
        strategy: 'role-name',
        selector: 'role=' + role + '[name="' + name.replace(/"/g, '\\"') + '"]',
        unique: matches === 1,
        role: role,
        name: name
      })
    }

    var text = textCandidate(el)
    if (text) candidates.push(text)

    var classes = classListOf(el)
    var cssSel = scopedCssPath(el)
    if (cssSel) {
      candidates.push({
        strategy: 'css',
        selector: cssSel,
        unique: isUnique(cssSel),
        classNames: classes
      })
    }

    var nthSel = nthChildPath(el)
    if (nthSel) {
      candidates.push({ strategy: 'nth-child', selector: nthSel, unique: isUnique(nthSel) })
    }

    return candidates
  }

  /** FR-SEC.2: is this element itself a secret field? */
  function isSecretElement(el) {
    if (!el || el.nodeType !== 1) return false
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password') return true
    var autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase()
    if (autocomplete === 'one-time-code' || autocomplete === 'current-password' || autocomplete === 'new-password') {
      return true
    }
    if (el.hasAttribute('data-nawi-secret')) return true
    for (var i = 0; i < SECRET_SELECTORS.length; i++) {
      try {
        if (el.matches(SECRET_SELECTORS[i])) return true
      } catch (e) {
        /* a bad configured selector must not disable the rest of the policy */
      }
    }
    return false
  }

  /**
   * One step up the *composed* tree.
   *
   * `parentElement` alone stops dead at a shadow boundary and at a document
   * boundary, so a field inside an open shadow root or a same-origin iframe
   * would be judged non-secret even when its host or its `<iframe>` carries the
   * marker. Climbing through `.host` and `frameElement` makes containment mean
   * what a reader assumes it means.
   */
  function climb(node) {
    if (node.parentElement) return node.parentElement
    var root = node.getRootNode ? node.getRootNode() : null
    if (root && root.host) return root.host
    try {
      var view = node.ownerDocument && node.ownerDocument.defaultView
      // Cross-origin: `frameElement` throws or is null. Either way we stop,
      // which is the fail-closed direction — see `eachElement`.
      if (view && view.frameElement) return view.frameElement
    } catch (e) {
      /* cross-origin parent; nothing further to climb */
    }
    return null
  }

  /** Secret by inheritance: anything inside a secret subtree is secret too. */
  function isSecret(el) {
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && depth < 500) {
      if (node.hasAttribute(MARKER)) return true
      if (isSecretElement(node)) return true
      node = climb(node)
      depth++
    }
    return false
  }

  /**
   * Every element reachable from `root`, descending through open shadow roots
   * and same-origin iframe documents.
   *
   * `document.querySelectorAll('*')` — what this replaced — pierces neither, and
   * that was a live FR-SEC.2 hole: `DOMSnapshot.captureSnapshot` *does* serialize
   * shadow and same-origin-frame content (`snapshot.ts` declares
   * `shadowRootType` for exactly that reason), so a `one-time-code` field inside
   * a design-system component or an embedded auth widget was serialized in full
   * while nothing had ever stamped it.
   *
   * **Cross-origin frames are deliberately not walked.** They are OOPIFs with a
   * separate CDP target and no session attached, so they are absent from the
   * snapshot entirely — already fail-closed. Reaching into them here would be
   * both impossible and pointless; the `try` below keeps a SecurityError from
   * aborting the walk over the frames we *can* see.
   */
  function eachElement(root, visit, depth) {
    if (!root || typeof root.querySelectorAll !== 'function') return
    if (depth > 20) return
    var all
    try {
      all = root.querySelectorAll('*')
    } catch (e) {
      return
    }
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      visit(el)
      if (el.shadowRoot) eachElement(el.shadowRoot, visit, depth + 1)
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        var doc = null
        try {
          doc = el.contentDocument
        } catch (e) {
          doc = null
        }
        if (doc) eachElement(doc, visit, depth + 1)
      }
    }
  }

  /**
   * Stamp every secret element (and its subtree) with the marker attribute.
   *
   * The marker exists so the main process can resolve these elements to
   * `backendNodeId`s via the DOM domain and filter them out of the snapshot —
   * the page has no visibility into backendNodeIds and cannot report them
   * itself. Returns counts only; no element content leaves this function.
   */
  function markSecrets() {
    var marked = 0
    var total = 0
    var names = {}

    function stamp(el) {
      if (!el.hasAttribute(MARKER)) {
        el.setAttribute(MARKER, '1')
        marked++
      }
    }

    /**
     * The submitted *parameter name* of a secret control, for the HAR's
     * request-body control (`har.ts`). A name is page structure, not page
     * content — it is the same class of fact as the role and the selector we
     * already record — and it never itself reaches disk: `harvest.ts` hands it
     * to `HarBuilder` purely as a redaction key. Bounded in length and count so
     * a hostile page cannot use it as an unbounded channel.
     */
    function noteFieldName(el) {
      if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') return
      for (var k = 0; k < 2; k++) {
        var value = k === 0 ? el.getAttribute('name') : el.getAttribute('id')
        if (typeof value !== 'string') continue
        value = value.trim()
        if (value && value.length <= 128) names[value] = true
      }
    }

    eachElement(
      document,
      function (el) {
        if (!isSecretElement(el)) return
        stamp(el)
        noteFieldName(el)
        // Descendants, including any nested inside the secret element's own
        // shadow root or frame — `eachElement` on an Element works the same way.
        eachElement(el, stamp, 0)
      },
      0
    )

    // Recount across every root rather than with a plain
    // `document.querySelectorAll`, which would under-report exactly the
    // shadow/frame elements this function now marks.
    eachElement(
      document,
      function (el) {
        if (el.hasAttribute(MARKER)) total++
      },
      0
    )

    var fieldNames = []
    for (var name in names) {
      if (Object.prototype.hasOwnProperty.call(names, name) && fieldNames.length < 100) {
        fieldNames.push(name)
      }
    }

    return { marked: marked, markerAttribute: MARKER, total: total, fieldNames: fieldNames }
  }

  /**
   * The exact FR-SEC.2 acceptance shape for an input event.
   *
   * For a secret target the `value` key is not merely blanked — it is never
   * constructed, so there is no moment at which the secret exists inside a
   * message object.
   */
  /**
   * Reference crops (roadmap AI1 visual anchor). Sides outside these bounds
   * (CSS px) get no crop: a smaller one can't tell controls apart (the
   * replayer's MIN_ANCHOR_SIDE), a larger one is a region, not a control.
   */
  var CROP_MIN_SIDE = 8
  var CROP_MAX_SIDE = 640
  /** Elements walked looking for a secret under the crop; a larger page gets no crop (fail closed). */
  var CROP_SCAN_MAX_ELEMENTS = 20000

  function round1(n) {
    return Math.round(n * 10) / 10
  }

  function isTopFrame() {
    try {
      return window.top === window
    } catch (e) {
      return false
    }
  }

  /**
   * The element's border box in the top viewport, CSS px `[x, y, width, height]`
   * (the recorded `bounds`, a flow step's `bbox`), or null: no layout box, or
   * inside a frame, whose own viewport is not the one a replay looks at.
   */
  function boxOf(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected || el.ownerDocument !== document || !isTopFrame()) return null
    var r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0 && isFinite(r.left) && isFinite(r.top))) return null
    return [round1(r.left), round1(r.top), round1(r.width), round1(r.height)]
  }

  /** Where `d` sits in the top viewport: its own rect, or the outermost frame element's when it lives in a frame; null if unknown. */
  function topRect(d) {
    var node = d
    for (var i = 0; i < 20 && node && node.ownerDocument !== document; i++) {
      var frame = null
      try {
        var view = node.ownerDocument && node.ownerDocument.defaultView
        frame = view ? view.frameElement : null
      } catch (e) {
        frame = null
      }
      node = frame
    }
    return node && node.ownerDocument === document ? node.getBoundingClientRect() : null
  }

  function overlaps(box, r) {
    return r.width > 0 && r.height > 0 && r.left < box[0] + box[2] && r.right > box[0] && r.top < box[1] + box[3] && r.bottom > box[1]
  }

  /**
   * The box a reference crop of `el` may be cut from, or null. The crop is
   * pixels of the viewport, so FR-SEC.2 is enforced on what is drawn there,
   * not only on `el`: no crop of a secret or of anything holding one, and none
   * when any element whose box overlaps it is secret (a secret field, or
   * anything inside a secret-marked subtree, marked yet or not), or is a
   * frame whose content can't be read (cross-origin, `<object>`, `<embed>`).
   * A secret whose place can't be worked out, or a page too large to check,
   * also means no crop. Only fully visible boxes within the size bounds
   * qualify. The harvester asks again after its screenshot (`cropBox` with
   * the same answer) and drops the crop if the page changed under it.
   */
  function cropBox(el) {
    var box = boxOf(el)
    if (!box) return null
    if (box[2] < CROP_MIN_SIDE || box[3] < CROP_MIN_SIDE || box[2] > CROP_MAX_SIDE || box[3] > CROP_MAX_SIDE) return null
    if (box[0] < 0 || box[1] < 0 || box[0] + box[2] > window.innerWidth || box[1] + box[3] > window.innerHeight) return null
    if (isSecret(el) || containsSecret(el)) return null
    var seen = 0
    var blocked = false
    eachElement(
      document,
      function (d) {
        if (blocked) return
        if (++seen > CROP_SCAN_MAX_ELEMENTS) {
          blocked = true
          return
        }
        var r = topRect(d)
        if (r === null) {
          // Inside a frame whose place in the top viewport is unknown.
          if (d.hasAttribute(MARKER) || isSecretElement(d)) blocked = true
          return
        }
        if (!overlaps(box, r)) return
        if (isSecret(d)) {
          blocked = true
          return
        }
        var tag = d.tagName
        // Plugin content is never walked.
        if (tag === 'OBJECT' || tag === 'EMBED') {
          blocked = true
          return
        }
        if (tag !== 'IFRAME' && tag !== 'FRAME') return
        // Same-origin frame documents are walked by eachElement itself; any other frame is unknown pixels.
        var doc = null
        try {
          doc = d.contentDocument
        } catch (e) {
          doc = null
        }
        if (!doc) blocked = true
      },
      0
    )
    return blocked ? null : box
  }

  function describeInput(el, type) {
    var secret = isSecret(el)
    var event = {
      type: type || 'input',
      target_role: roleOf(el) || null,
      target_name: secret ? null : accessibleName(el) || null,
      selectors: describeSelectors(el),
      bounds: boxOf(el)
    }
    // The browser-normalized type (`el.type`: an unknown attribute reads as
    // "text"), so a consumer can tell a file picker or a slider from a text
    // field: roleOf calls all of them "textbox".
    if (el && el.tagName === 'INPUT' && typeof el.type === 'string') event.input_type = el.type
    if (secret) {
      event.value_redacted = true
    } else {
      var value = el && typeof el.value === 'string' ? el.value : null
      if (value !== null) event.value = value
      event.value_redacted = false
    }
    return event
  }

  window.__nawiProbe = {
    version: 1,
    markerAttribute: MARKER,
    describeSelectors: describeSelectors,
    /** The same role/name approximation the recorded `role-name` candidates used, for the replayer to match them. */
    roleOf: roleOf,
    accessibleName: accessibleName,
    /** The `{ text }` locator rule, shared with the replayer. */
    textMatches: textMatches,
    describeInput: describeInput,
    /** A reference crop's box for an element about to be clicked, or null (see cropBox). */
    cropBox: cropBox,
    isSecret: isSecret,
    isSecretElement: isSecretElement,
    markSecrets: markSecrets,
    /** Resolve the element under a viewport point, for FR-CAP.5 element picking. */
    describePoint: function (x, y) {
      var el = document.elementFromPoint(x, y)
      return el ? { selectors: describeSelectors(el), role: roleOf(el), name: accessibleName(el) } : null
    }
  }
})()
