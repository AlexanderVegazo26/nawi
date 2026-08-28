/**
 * FR-STA.4 input-event listener.
 *
 * **There is no CDP domain that observes user input**, so this is the only way
 * to get the event stream. It is injected with
 * `Page.addScriptToEvaluateOnNewDocument` and forwards over a
 * `Runtime.addBinding` binding.
 *
 * **This file is a forwarder, not a second implementation.** Every payload is
 * built by `window.__nawiProbe.describeInput`, which is where FR-SEC.2's
 * value suppression lives. Constructing a payload here — reading `e.target.value`
 * directly, say — would route around Tier A entirely for the exact code path the
 * requirement names. If the probe is not present, this emits nothing rather than
 * falling back to something unfiltered.
 *
 * `Runtime.bindingCalled` carries no timestamp (verified against a live
 * Chromium: it delivers only `{name, payload, executionContextId}`), so the
 * payload carries its own `performance.timeOrigin + performance.now()` — browser
 * epoch milliseconds, which the main side converts with `browserToTMs`.
 *
 * Plain ES5-ish JS with no imports: it is stringified into an arbitrary page.
 */
;(function () {
  'use strict'

  var BINDING = '__NAWI_BINDING__'
  /**
   * Stamped on every payload; the main side drops anything without it. Both the
   * binding name and this value are generated per session by `harvest.ts` — see
   * the note there for exactly how much this is worth, which is "raises the cost
   * of forgery", not "authenticates the sender".
   */
  var NONCE = '__NAWI_NONCE__'
  if (window.__nawiListener) return
  window.__nawiListener = { version: 1 }

  function emit(payload) {
    try {
      var fn = window[BINDING]
      if (typeof fn !== 'function') return
      payload.nonce = NONCE
      fn(JSON.stringify(payload))
    } catch (e) {
      /* A page that broke JSON.stringify must not break the page itself. */
    }
  }

  /** Never construct an event without the probe: that would bypass suppression. */
  function describe(target, type) {
    var probe = window.__nawiProbe
    if (!probe || typeof probe.describeInput !== 'function') return null
    if (!target || target.nodeType !== 1) return null
    try {
      return probe.describeInput(target, type)
    } catch (e) {
      return null
    }
  }

  function send(target, type, coordinates) {
    var described = describe(target, type)
    if (!described) return
    described.at = performance.timeOrigin + performance.now()
    described.coordinates = coordinates || null
    emit(described)
  }

  document.addEventListener(
    'click',
    function (e) {
      send(e.target, 'click', { x: e.clientX, y: e.clientY })
    },
    true
  )

  /**
   * `input` rather than `keydown` for value-bearing fields: FR-SEC.2's
   * acceptance names `{type: "input", …}` specifically, and it is the event that
   * actually corresponds to "the user typed into this field".
   */
  document.addEventListener(
    'input',
    function (e) {
      send(e.target, 'input', null)
    },
    true
  )

  document.addEventListener(
    'keydown',
    function (e) {
      // Only non-character keys: a character keydown on a secret field would
      // carry the key in `e.key`, and the probe has no say over that. Navigation
      // and control keys are what the guide generator actually needs.
      if (e.key && e.key.length === 1) return
      var described = describe(e.target, 'keydown')
      if (!described) return
      described.at = performance.timeOrigin + performance.now()
      described.coordinates = null
      described.key = e.key
      emit(described)
    },
    true
  )

  var scrollPending = false
  window.addEventListener(
    'scroll',
    function () {
      // Scroll fires per frame; one event per animation frame is plenty and
      // keeps a long recording from drowning the NDJSON file.
      if (scrollPending) return
      scrollPending = true
      requestAnimationFrame(function () {
        scrollPending = false
        emit({
          type: 'scroll',
          target_role: null,
          target_name: null,
          selectors: [],
          value_redacted: false,
          at: performance.timeOrigin + performance.now(),
          coordinates: { x: window.scrollX, y: window.scrollY }
        })
      })
    },
    true
  )

  window.addEventListener('resize', function () {
    emit({
      type: 'resize',
      target_role: null,
      target_name: null,
      selectors: [],
      value_redacted: false,
      at: performance.timeOrigin + performance.now(),
      coordinates: { x: window.innerWidth, y: window.innerHeight }
    })
  })
})()
