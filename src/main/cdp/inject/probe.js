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

  /** Secret by inheritance: anything inside a secret subtree is secret too. */
  function isSecret(el) {
    var node = el
    while (node && node.nodeType === 1) {
      if (node.hasAttribute(MARKER)) return true
      if (isSecretElement(node)) return true
      node = node.parentElement
    }
    return false
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
    var all = document.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (!isSecretElement(el)) continue
      if (!el.hasAttribute(MARKER)) {
        el.setAttribute(MARKER, '1')
        marked++
      }
      var descendants = el.querySelectorAll('*')
      for (var j = 0; j < descendants.length; j++) {
        if (!descendants[j].hasAttribute(MARKER)) {
          descendants[j].setAttribute(MARKER, '1')
          marked++
        }
      }
    }
    return { marked: marked, markerAttribute: MARKER, total: document.querySelectorAll('[' + MARKER + ']').length }
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
