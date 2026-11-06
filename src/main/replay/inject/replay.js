/**
 * Page-side half of the flow replayer (roadmap F3).
 *
 * Installed next to `cdp/inject/probe.js` and inlined into `replay.ts` via
 * Vite's `?raw`. It resolves a step's ranked selectors to one element and
 * reports facts about it; the main side decides what those facts mean and
 * drives real input through CDP (`Input.dispatch*`), so a replayed click is a
 * trusted event, not `el.click()`.
 *
 * Every entry point returns plain JSON and never throws for "not there yet":
 * the main side polls until the step's deadline, so "no element" is a normal
 * answer. `role`/`name` selectors reuse the probe's own approximation, the one
 * the recording used when it ranked them, so a recorded locator resolves the
 * same way it was measured.
 */
;(function () {
  'use strict'

  if (window.__nawiReplay) return

  var TESTID_ATTR = 'data-testid'

  function probe() {
    return window.__nawiProbe || null
  }

  function textOf(el) {
    var tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return String(el.value == null ? '' : el.value)
    return String(el.innerText == null ? el.textContent || '' : el.innerText)
  }

  /** All elements a selector matches, in document order. */
  function matchesFor(selector) {
    if (selector.text !== undefined) {
      // The probe's rule, the one the recorder measured the text candidate with.
      var tp = probe()
      if (!tp || typeof tp.textMatches !== 'function') return { invalid: 'text selectors need the page probe, which is not installed' }
      return tp.textMatches(selector.text)
    }
    if (selector.testid !== undefined) {
      return Array.prototype.slice.call(document.querySelectorAll('[' + TESTID_ATTR + '="' + CSS.escape(selector.testid) + '"]'))
    }
    if (selector.id !== undefined) {
      // getElementById returns the first of duplicates; count them all so an
      // ambiguous id falls through to the next locator instead of picking one.
      return Array.prototype.slice.call(document.querySelectorAll('#' + CSS.escape(selector.id)))
    }
    if (selector.css !== undefined) {
      try {
        return Array.prototype.slice.call(document.querySelectorAll(selector.css))
      } catch (e) {
        return { invalid: String((e && e.message) || e) }
      }
    }
    if (selector.role !== undefined) {
      var p = probe()
      if (!p || typeof p.roleOf !== 'function') return { invalid: 'role selectors need the page probe, which is not installed' }
      var all = document.querySelectorAll('*')
      var out = []
      for (var i = 0; i < all.length; i++) {
        if (p.roleOf(all[i]) !== selector.role) continue
        if (selector.name !== undefined && p.accessibleName(all[i]) !== selector.name) continue
        out.push(all[i])
      }
      return out
    }
    return { invalid: 'unknown selector shape' }
  }

  /**
   * The first selector, in the flow's order, that matches exactly one element.
   * `tried` says what every earlier selector found, so a run record can show
   * which locator broke and how.
   */
  function locate(selectors) {
    var tried = []
    for (var i = 0; i < selectors.length; i++) {
      var found = matchesFor(selectors[i])
      if (!Array.isArray(found)) {
        tried.push({ index: i, found: 0, invalid: found.invalid })
        continue
      }
      if (found.length === 1) return { el: found[0], index: i, tried: tried }
      tried.push({ index: i, found: found.length })
    }
    return { el: null, index: -1, tried: tried }
  }

  function isVisible(el) {
    if (!el.isConnected) return false
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false
    var r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function isEnabled(el) {
    if (el.matches && el.matches(':disabled')) return false
    var aria = el.closest && el.closest('[aria-disabled="true"]')
    return !aria
  }

  /** Inputs whose value is typed through a picker: Input.insertText does nothing to them. */
  var SET_VALUE_TYPES = ['date', 'time', 'datetime-local', 'month', 'week']

  function inputType(el) {
    return el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : ''
  }

  function isEditable(el) {
    var tag = el.tagName
    if (tag === 'TEXTAREA') return !el.readOnly
    if (tag === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase()
      var nonText = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color']
      return nonText.indexOf(type) === -1 && !el.readOnly
    }
    return el.isContentEditable === true
  }

  function describeEl(el) {
    var s = el.tagName.toLowerCase()
    if (el.id) s += '#' + el.id
    return s
  }

  function base(result) {
    return { found: true, index: result.index, tried: result.tried }
  }

  function missing(result) {
    return { found: false, index: -1, tried: result.tried }
  }

  /** Facts for `assert` and `wait` steps. */
  function state(selectors) {
    var r = locate(selectors)
    if (!r.el) return missing(r)
    var out = base(r)
    out.visible = isVisible(r.el)
    out.enabled = isEnabled(r.el)
    out.text = textOf(r.el)
    return out
  }

  /**
   * Make the element ready for a pointer action and return the viewport point
   * to send it to. `blocked` explains why it is not actionable yet (the main
   * side keeps polling until the deadline, then reports the last reason).
   */
  function point(selectors, needEnabled) {
    var r = locate(selectors)
    if (!r.el) return missing(r)
    var out = base(r)
    var el = r.el
    if (!isVisible(el)) {
      out.blocked = 'it is not visible'
      return out
    }
    if (needEnabled && !isEnabled(el)) {
      out.blocked = 'it is disabled'
      return out
    }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    var rect = el.getBoundingClientRect()
    var x = rect.left + rect.width / 2
    var y = rect.top + rect.height / 2
    var hit = document.elementFromPoint(x, y)
    if (hit !== el && !(hit && el.contains(hit))) {
      // A label wrapping/naming the control forwards the click; anything else
      // (an overlay, a cookie banner) would swallow it.
      var label = hit && hit.closest ? hit.closest('label') : null
      var forwards = label !== null && label.control === el
      if (!forwards) {
        out.blocked = hit ? 'it is covered by ' + describeEl(hit) : 'it is outside the viewport'
        return out
      }
    }
    out.x = x
    out.y = y
    return out
  }

  /**
   * Fields this document received a secret in. Screenshots mask them
   * (`mask`), even when the step's locators no longer find them.
   */
  var secretFields = []
  /** What `mask` changed, so `unmask` puts each inline style back exactly. */
  var masked = []
  /**
   * Which `mask` call the current mask belongs to. A capture that finishes
   * late must not unmask the fields under a newer capture.
   */
  var maskGeneration = 0
  var MASK_PROP = '-webkit-text-security'

  /**
   * Focus a text field and select its contents, so typed text replaces them.
   * `secret`: the value about to be typed holds a secret; remember the field.
   */
  function focusForFill(selectors, secret) {
    var r = locate(selectors)
    if (!r.el) return missing(r)
    var out = base(r)
    var el = r.el
    if (secret && secretFields.indexOf(el) === -1) secretFields.push(el)
    if (!isVisible(el)) {
      out.blocked = 'it is not visible'
      return out
    }
    if (!isEnabled(el)) {
      out.blocked = 'it is disabled'
      return out
    }
    if (!isEditable(el)) {
      out.blocked = 'it is not a text field (' + describeEl(el) + ')'
      out.permanent = true
      return out
    }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    el.focus()
    if (typeof el.select === 'function') {
      el.select()
    } else {
      var range = document.createRange()
      range.selectNodeContents(el)
      var sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
    out.focused = document.activeElement === el
    if (!out.focused) out.blocked = 'it could not be focused'
    if (SET_VALUE_TYPES.indexOf(inputType(el)) !== -1) out.setValue = true
    return out
  }

  /**
   * Set a picker-style input's value the way a framework notices (the native
   * setter, then input + change), and refuse a value the input rejected
   * (`<input type=date>` silently drops "01/02/1990").
   */
  function setValue(selectors, value) {
    var r = locate(selectors)
    if (!r.el) return missing(r)
    var out = base(r)
    var el = r.el
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    if (el.value !== value) {
      out.blocked = 'it rejected the value (a ' + inputType(el) + ' input expects its own format, e.g. 2026-01-31 for a date)'
      out.permanent = true
    }
    return out
  }

  /** Focus the target of a `press` step. */
  function focus(selectors) {
    var r = locate(selectors)
    if (!r.el) return missing(r)
    var out = base(r)
    if (!isVisible(r.el)) {
      out.blocked = 'it is not visible'
      return out
    }
    r.el.focus()
    if (document.activeElement !== r.el) out.blocked = 'it could not be focused'
    return out
  }

  /** Choose an option of a <select> by value, then by its visible label. */
  function selectOption(selectors, value) {
    var r = locate(selectors)
    if (!r.el) return missing(r)
    var out = base(r)
    var el = r.el
    if (el.tagName !== 'SELECT') {
      out.blocked = 'it is not a <select> (' + describeEl(el) + ')'
      out.permanent = true
      return out
    }
    if (!isEnabled(el)) {
      out.blocked = 'it is disabled'
      return out
    }
    var options = Array.prototype.slice.call(el.options)
    var match = options.filter(function (o) { return o.value === value })[0]
    if (!match) match = options.filter(function (o) { return (o.label || o.text).trim() === value.trim() })[0]
    if (!match) {
      out.blocked = 'it has no option with that value or label (' + options.length + ' options)'
      return out
    }
    if (match.disabled) {
      out.blocked = 'that option is disabled'
      return out
    }
    el.value = match.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return out
  }

  /** Scroll the page, or an element, by a delta; with no delta, bring the element into view. */
  function scroll(selectors, dx, dy) {
    if (!selectors) {
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
      return { found: true, index: -1, tried: [] }
    }
    var r = locate(selectors)
    if (!r.el) return missing(r)
    var out = base(r)
    if (dx === 0 && dy === 0) r.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    else r.el.scrollBy({ left: dx, top: dy, behavior: 'instant' })
    return out
  }

  /** The element's box in page (document) coordinates, for a clipped screenshot. */
  function box(selectors) {
    var r = locate(selectors)
    if (!r.el) return missing(r)
    var out = base(r)
    if (!isVisible(r.el)) {
      out.blocked = 'it is not visible'
      return out
    }
    r.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    var rect = r.el.getBoundingClientRect()
    out.box = { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height }
    return out
  }

  /**
   * Draw every field that received a secret as discs, for a screenshot: the
   * ones marked by `focusForFill` that are still in the page, plus whatever
   * each selector list in `lists` resolves to now. Returns the generation to
   * hand back to `unmask`. The browser masks password inputs already; this
   * covers secrets typed into ordinary text fields, text areas and editable
   * elements.
   */
  function mask(lists) {
    restore()
    var els = secretFields.filter(function (el) {
      return el.isConnected
    })
    for (var i = 0; i < lists.length; i++) {
      var r = locate(lists[i])
      if (r.el && els.indexOf(r.el) === -1) els.push(r.el)
    }
    for (var j = 0; j < els.length; j++) {
      var style = els[j].style
      masked.push({ el: els[j], value: style.getPropertyValue(MASK_PROP), priority: style.getPropertyPriority(MASK_PROP) })
      style.setProperty(MASK_PROP, 'disc', 'important')
    }
    maskGeneration++
    return { found: true, index: -1, tried: [], generation: maskGeneration }
  }

  /** Undo `mask` number `generation`, unless a newer mask replaced it. */
  function unmask(generation) {
    if (generation === maskGeneration) restore()
    return { found: true, index: -1, tried: [] }
  }

  /** Put each masked field's own inline value back (usually none). */
  function restore() {
    for (var i = 0; i < masked.length; i++) {
      var m = masked[i]
      if (m.value) m.el.style.setProperty(MASK_PROP, m.value, m.priority)
      else m.el.style.removeProperty(MASK_PROP)
    }
    masked = []
  }

  window.__nawiReplay = {
    version: 1,
    mask: mask,
    unmask: unmask,
    state: state,
    point: point,
    focusForFill: focusForFill,
    setValue: setValue,
    focus: focus,
    selectOption: selectOption,
    scroll: scroll,
    box: box
  }
})()
