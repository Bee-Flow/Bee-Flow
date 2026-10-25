// @typecheck noImplicitAny
/**
 * FAIR FAILURE at every place where a BRIDGE runs — one mechanism, two bridges.
 *
 * ── THE GAP THIS MODULE CLOSES ──────────────────────────────────────
 *
 * On a react page JS runs, but the bridges that the elements need are not there:
 * `beeflowTables` refuses, and `beeflowAutomations` until recently was a no-op that RESOLVED.
 * A `bf-*` element that depends on that can therefore do nothing there — and without help that
 * is INVISIBLE: an undefined custom element is `display:inline` with no children, in other words
 * an empty box. A reader sees an empty table (which reads as "there are no rows") or a button that
 * does nothing without saying why.
 *
 * This mechanism stood at first only in services/publicBridgeScript.js, and that bridge is
 * injected ONLY when the author has switched on public AI — a setting that is OFF by default
 * (stores/webpage/bridgeGrants.js). On the default public react share, therefore, only the baked-in
 * stub from reactBundleServer.js ran, and that stub did not know the mechanism: all five elements
 * were silently dead there. Exactly what W4 exists to eliminate, and then on the DEFAULT PATH.
 * That is why the mechanism now lives here, and both bridges bake it in unconditionally.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────
 *
 * Not a single tag name, not a single sentence that the reader sees. Everything comes from
 * `bridgeVocabulary(surface)` in core/webpages/bfElements.js; only the mechanism is here.
 * core/webpages/bfElements.drift.test.js forbids a hand-written tag name in this file.
 *
 * ── THE PLACE IS A PARAMETER, NOT AN ASSUMPTION ─────────────────────
 *
 * The same stub serves TWO places: the public share (`reactShare`) and the picture that the builder AI
 * gets of the author's page (`headlessRender`, services/webpageRender.js). There, "on a shared link"
 * would lie about a page that works normally when logged in, so each place carries its own sentence in
 * the registry. Whoever adds a place here adds it to BRIDGE_SURFACES, and the registry enforces the texts.
 *
 * ── WHICH ELEMENTS ARE MARKED ───────────────────────────────────────
 *
 * Everything that does NOT work itself in this place: every state except `live` (the element does it
 * here) and `static` (the snapshot writer has already replaced the element with plain HTML before
 * DOMPurify, so it is no longer in the DOM). So also `inert`, and also a `bf-*` element that the
 * vocabulary does NOT know — that last one would otherwise be the only element that still disappears
 * silently here, while the client side draws a notice for it.
 */

'use strict';

const { bridgeVocabulary } = require('../core/webpages/bfElements');

/**
 * JSON that is safe to sit inside an inline `<script>`.
 *
 * Otherwise a `</script>` in a text from the vocabulary would cut the bridge in two and let everything
 * after it disappear. The client twin (agent-hub/src/utils/bfElementsRuntime.js) escapes with the same
 * three lines; two different conventions for escaping are just as much drift as two lists.
 * @param {string | { [x: string]: object; }} value
 */
function jsonLiteral(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * The block that sets `window.beeflowBf` and gives every element that cannot do anything here a visible
 * notice.
 *
 * Yields a FRAGMENT, not a `<script>`: both bridges already have their own IIFE, and one script block per
 * bridge is what their tests pin down.
 *
 * @param {string} surface  one of bfElements.BRIDGE_SURFACES
 * @returns {string} JavaScript source text
 */
function buildBfNoticeScript(surface) {
    const literal = jsonLiteral(bridgeVocabulary(surface));
    return `
  // The element vocabulary as it applies HERE, derived from
  // core/webpages/bfElements.js. An element this list does not know is
  // "unknown": recognisably unknown, never silently fine.
  var BF_MARK = "data-bf-state";
  var BF_PREFIX = "bf-";
  window.beeflowBf = {
    elements: ${literal},
    lookup: function(tag){ return this.elements[String(tag || "").toLowerCase()] || null; },
    state: function(tag){ var e = this.lookup(tag); return e ? e.state : "unknown"; },
    reason: function(tag){
      var e = this.lookup(tag);
      if (e) return e.message || null;
      return "Unknown Bee Flow element " + String(tag || "");
    },
    // What the READER gets to see. Falls back to the developer text, and
    // then to a sentence that at least says it cannot work here: silence is
    // the one answer we must never give.
    notice: function(tag){
      var e = this.lookup(tag);
      if (e && e.notice) return e.notice;
      if (e && e.message) return e.message;
      return "This Bee Flow element is not available here.";
    },
    // Walk the tree again. Same name and same intent as on the client
    // side, so page code can ask the same question in both places; here it
    // is also the way out for code that inserts nodes in a way that does
    // not trigger the custom-element hook.
    refresh: function(root){ return bfSweep(root); }
  };
  // Does this element work here itself? "live" does; "static" is no longer
  // there (the snapshot writer replaced it). Everything else (inert, refused,
  // and an element we do not know) gets a notice.
  function bfSilentHere(state){ return state !== "live" && state !== "static"; }
  function bfIsOurs(tag){ return String(tag || "").toLowerCase().indexOf(BF_PREFIX) === 0; }
  function bfDecorate(el){
    if (!el || el.nodeType !== 1 || el.hasAttribute(BF_MARK)) return false;
    var tag = String(el.tagName || "").toLowerCase();
    if (!bfIsOurs(tag)) return false;
    var state = window.beeflowBf.state(tag);
    if (!bfSilentHere(state)) return false;
    el.setAttribute(BF_MARK, state);
    var box = document.createElement("div");
    box.setAttribute("data-bf-notice", tag);
    box.setAttribute("role", "note");
    // currentColor + opacity, so the notice stays readable on any
    // background the author chose. The page carries its own stylesheet;
    // we know nothing about it.
    box.setAttribute("style", "display:block;margin:.25em 0;padding:.5em .75em;border:1px dashed currentColor;border-radius:4px;opacity:.7;font:inherit;font-size:.9em");
    // textContent, never innerHTML: this is our own text and it has to stay
    // that way, even if a variable part is ever added.
    box.textContent = window.beeflowBf.notice(tag);
    // Append, do not replace: what the author wrote in the element
    // (a label, a fallback text) is theirs and stays.
    el.appendChild(box);
    return true;
  }
  // The tags we may define a custom element for: everything we KNOW
  // that can do nothing here. An unknown tag is by definition not in this
  // list; the sweep finds it.
  function bfSilentTags(){
    var vocab = window.beeflowBf.elements;
    return Object.keys(vocab).filter(function(tag){ return bfSilentHere(vocab[tag].state); });
  }
  // The custom-element hook below covers everything the app inserts later
  // (React does exactly that). This sweep covers what was already there,
  // every element with our prefix that we do NOT know, and is the way out
  // for code that inserts nodes in a way that does not trigger that hook.
  // That is why it scans on "*" and not on the list of tags.
  function bfSweep(root){
    var scope = root || document;
    var done = 0;
    if (scope.nodeType === 1 && bfDecorate(scope)) done++;
    var all;
    try { all = scope.querySelectorAll("*"); } catch (e) { return done; }
    for (var i = 0; i < all.length; i++) if (bfDecorate(all[i])) done++;
    return done;
  }
  (function(){
    var CE = window.customElements;
    if (CE && typeof CE.define === "function"){
      bfSilentTags().forEach(function(tag){
        // Wie eerder was, wint — een tweede define op dezelfde naam GOOIT, en
        // dat zou de rest van deze brug meenemen. Deze brug staat in <head>,
        // dus in de praktijk zijn wij eerst.
        if (CE.get(tag)) return;
        try {
          CE.define(tag, class extends HTMLElement {
            connectedCallback(){ bfDecorate(this); }
          });
        } catch (e) {}
      });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ bfSweep(); });
    else bfSweep();
  })();`;
}

module.exports = { buildBfNoticeScript, jsonLiteral };
