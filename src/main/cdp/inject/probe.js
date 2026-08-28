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
      var part = node.tagName.toLowerCase()
      var classes = classListOf(node)
      if (classes.length) part += '.' + cssEscape(classes[0])
      parts.unshift(part)
      if (node.id && !/\s/.test(node.id)) {
        parts.unshift('#' + cssEscape(node.id))
        break
      }
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
      var ref = document.getElementById(labelledBy)
      if (ref) return (ref.textContent || '').trim()
    }
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (el.labels && el.labels.length) return (el.labels[0].textContent || '').trim()
      var placeholder = el.getAttribute('placeholder')
      if (placeholder) return placeholder.trim()
    }
    return (el.textContent || '').trim().slice(0, 120)
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
  function describeInput(el, type) {
    var secret = isSecret(el)
    var event = {
      type: type || 'input',
      target_role: roleOf(el) || null,
      target_name: secret ? null : accessibleName(el) || null,
      selectors: describeSelectors(el)
    }
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
    describeInput: describeInput,
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
