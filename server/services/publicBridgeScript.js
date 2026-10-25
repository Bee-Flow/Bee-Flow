// @typecheck noImplicitAny
/**
 * Public-share AI bridge script (server-emitted).
 *
 * A CommonJS server twin of the client bridge in agent-hub/src/utils/composeWebpageDocument.js —
 * hand-kept, not imported, because that file is ESM frontend code (same reason reactBundleServer.js
 * keeps its own copy of the client builder). Injected at content-serve time into an externally-shared
 * react-mui page ONLY when the author opted the share into public AI. It runs AFTER the baked stub
 * bridge (reactBundleServer.buildStubBridgeScript), so its window.beeflowAI overrides the stub (later
 * definition wins).
 *
 * Differences from the in-app bridge:
 *   - Static bearer token baked in (no parent session, so no postMessage token-refresh). On 401 the
 *     call rejects; the viewer reloads the page to get a fresh 30-min token.
 *   - BASE = apiBase + "/api/public-share" (the token carries the webpageId, so there is no "/:id"
 *     path segment).
 *   - Exposes ONLY beeflowAI.{chat,chatJSON,stream}. beeflowDB, beeflowApp, beeflowAutomations,
 *     beeflowIntegrations, and beeflowAI.ask stay stubbed as resolve-empty no-ops so page code
 *     degrades gracefully instead of throwing (the server refuses those surfaces for anonymous viewers
 *     anyway).
 *   - beeflowTables REJECTS rather than resolving empty: "no rows" and "you cannot read a table here"
 *     must not look the same. A public share shows a table only as the static HTML the snapshot writer
 *     rendered from publicColumns (services/webpageBfTable.js).
 *
 * ── THE ELEMENT VOCABULARY IS NOT HERE ──────────────────────────────
 *
 * `window.beeflowBf` is DERIVED from core/webpages/bfElements.js (`publicShareVocabulary()`) and not
 * explained here. That is the whole point: this file has already once drifted out of step with its client
 * twin — the `beeflowAI` surface still differs per file today — and a list that you maintain by hand is
 * maintained by nobody. Adding an element to the vocabulary, or an ATTRIBUTE to an existing element,
 * changes what this function emits by itself; nothing can be forgotten. Every entry carries a reason
 * instead of silence, just as beeflowTables above REFUSES instead of giving an empty list. That is why
 * this file deliberately contains NO tag name — not even in a comment; bfElements.drift.test.js forbids
 * it, because any name written here by hand can fall behind.
 *
 * ── AND THE ELEMENTS FAIL VISIBLY HERE ──────────────────────────────
 *
 * On a react share JS does run, but the table bridge does not exist there and the automation bridge is a
 * no-op. An element that depends on that can therefore do nothing here, and without help that is
 * INVISIBLE: an undefined custom element is `display:inline` with no children — an empty box. A reader then
 * sees an empty table (which reads as "there are no rows") or a button that does nothing without saying why.
 * With the automation bridge it is one degree worse: that one RESOLVES, so a home-made button reports success
 * without anything having happened.
 *
 * That is why this bridge defines, for every REFUSED element, a custom element that shows its own refusal.
 * The list and the text come from the vocabulary; only the mechanism is here. The same rule as in the vanilla
 * snapshot, where the expander places a visibly disabled block before DOMPurify: dead is allowed, silent is not.
 */

const { buildBfNoticeScript, jsonLiteral } = require('./bfBridgeNotices');

/**
 * @typedef {Object} BuildPublicBridgeScriptArgs
 * @property {string} [token]
 * @property {string} [apiBase]
 */
/**
 * @param {BuildPublicBridgeScriptArgs} param0
 */
function buildPublicBridgeScript({ token, apiBase }) {
    // jsonLiteral, not JSON.stringify: a `</script>` in a value would cut the bridge in two and make everything
    // after it (among others beeflowIntegrations) disappear.
    const tokenLiteral = jsonLiteral(String(token || ''));
    const baseLiteral = jsonLiteral(String(apiBase || '').replace(/\/+$/, '') + '/api/public-share');
    return `<script>(function(){
  var TOKEN = ${tokenLiteral};
  var BASE = ${baseLiteral};
  function stampAuth(init){
    var next = Object.assign({}, init || {});
    next.headers = Object.assign({}, (init && init.headers) || {});
    next.headers.Authorization = "Bearer " + TOKEN;
    return next;
  }
  function fetchWithAuth(url, init){ return fetch(url, stampAuth(init)); }
  function jsonHeaders(){ return { "Content-Type": "application/json" }; }
  async function postJson(path, body){
    var res = await fetchWithAuth(BASE + path, {
      method: "POST", headers: jsonHeaders(),
      body: body ? JSON.stringify(body) : undefined
    });
    var json = null;
    try { json = await res.json(); } catch(_){}
    if (!res.ok){
      var err = new Error((json && json.error) || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    return json;
  }
  // Parse a fetch ReadableStream of SSE chunks (event: <name>\\ndata: <json>\\n\\n).
  async function streamSSE(path, body, onEvent){
    var res = await fetchWithAuth(BASE + path, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body || {}) });
    if (!res.ok){
      var errJson = null;
      try { errJson = await res.json(); } catch(_){}
      var err = new Error((errJson && errJson.error) || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    while (true){
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var parts = buf.split("\\n\\n");
      buf = parts.pop();
      for (var i = 0; i < parts.length; i++){
        var block = parts[i];
        var ev = "message", data = "";
        var lines = block.split("\\n");
        for (var j = 0; j < lines.length; j++){
          var line = lines[j];
          if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
          else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
        }
        var parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch(_){}
        try { onEvent(ev, parsed); } catch(_){}
      }
    }
  }
  var noop = function(){ return Promise.resolve(); };
  window.beeflowAI = {
    chat: function(prompt, opts){
      var body = Object.assign({ prompt: prompt }, opts || {});
      return postJson("/ai/chat", body).then(function(r){ return r.text; });
    },
    chatJSON: function(prompt, schema, opts){
      var body = Object.assign({ prompt: prompt, schema: schema }, opts || {});
      return postJson("/ai/chat", body).then(function(r){ return r.json; });
    },
    stream: function(prompt, onToken, opts){
      var body = Object.assign({ prompt: prompt }, opts || {});
      var full = "";
      return streamSSE("/ai/stream", body, function(ev, data){
        if (ev === "content" && data && typeof data.text === "string"){
          full += data.text;
          try { onToken && onToken(data.text); } catch(_){}
        }
      }).then(function(){ return full; });
    },
    // Agentic tool loop is NOT available to anonymous share visitors.
    ask: function(){ return Promise.reject(new Error("beeflowAI.ask is not available on shared links")); }
  };
  // Side-effecting bridges stay stubbed for anonymous viewers (mirror the baked
  // stub) — the server refuses them regardless; these keep page code from
  // throwing ReferenceError.
  window.beeflowDB = { query:function(){return Promise.resolve([]);}, exec:function(){return Promise.resolve({changes:0});}, batch:function(){return Promise.resolve([]);} };
  window.beeflowApp = { call:function(){return Promise.resolve({});} };
  // run() REFUSES, like beeflowTables below and for the same reason. A
  // no-op that resolves is the most dangerous of all here: a hand-built
  // button then reports "Sent!" while nothing was run. list() may answer
  // empty: "you may not list automations here" and "there are none"
  // amount to the same thing there, and page code iterating over it does not break.
  function noRun(){ return Promise.reject(new Error("beeflowAutomations.run is not available on shared links")); }
  window.beeflowAutomations = { run:noRun, list:function(){return Promise.resolve([]);} };
  // Table bindings do NOT exist on a public share. Deliberately a REFUSAL
  // and not an empty list like the stubs above: an empty list reads as "the
  // table has no rows", which is something different from "you cannot read a
  // table here". What a public reader does get to see of a table, the
  // snapshot writer rendered server-side from publicColumns
  // (services/webpageBfTable.js).
  function noTables(){ return Promise.reject(new Error("beeflowTables is not available on shared links")); }
  window.beeflowTables = { query:noTables, insert:noTables, update:noTables };
${buildBfNoticeScript('reactShare')}
  try { window.beeflowIntegrations = new Proxy({}, { get:function(){ return noop; } }); }
  catch(e){ window.beeflowIntegrations = {}; }
})();<\/script>`;
}

module.exports = { buildPublicBridgeScript };
