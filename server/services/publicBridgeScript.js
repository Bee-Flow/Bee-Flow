/**
 * Public-share AI bridge script (server-emitted).
 *
 * A CommonJS server twin of the client bridge in
 * agent-hub/src/utils/composeWebpageDocument.js — hand-kept, not imported,
 * because that file is ESM frontend code (same reason reactBundleServer.js
 * keeps its own copy of the client builder). Injected at content-serve time
 * into an externally-shared react-mui page ONLY when the author opted the
 * share into public AI. It runs AFTER the baked stub bridge
 * (reactBundleServer.buildStubBridgeScript), so its window.beeflowAI overrides
 * the stub (later definition wins).
 *
 * Differences from the in-app bridge:
 *   - Static bearer token baked in (no parent session, so no postMessage
 *     token-refresh). On 401 the call rejects; the viewer reloads the page to
 *     get a fresh 30-min token.
 *   - BASE = apiBase + "/api/public-share" (the token carries the webpageId, so
 *     there is no "/:id" path segment).
 *   - Exposes ONLY beeflowAI.{chat,chatJSON,stream}. beeflowDB, beeflowApp,
 *     beeflowAutomations, beeflowIntegrations, and beeflowAI.ask stay stubbed
 *     as resolve-empty no-ops so page code degrades gracefully instead of
 *     throwing (server refuses those surfaces for anonymous viewers anyway).
 *   - beeflowTables REJECTS rather than resolving empty: "no rows" and "you
 *     cannot read a table here" must not look the same. A public share shows a
 *     table only as the static HTML the snapshot writer rendered from
 *     publicColumns (services/webpageBfTable.js).
 *
 * ── HET ELEMENTVOCABULAIRE STAAT HIER NIET ──────────────────────────
 *
 * `window.beeflowBf` wordt AFGELEID uit core/webpages/bfElements.js
 * (`publicShareVocabulary()`) en niet hier verklaard. Dat is het hele punt: dit
 * bestand is al eens uit de pas gaan lopen met zijn client-tweeling — het
 * `beeflowAI`-oppervlak verschilt vandaag nog per bestand — en een lijst die je
 * met de hand bijhoudt, houdt niemand bij. Een element toevoegen aan het
 * vocabulaire, of een ATTRIBUUT aan een bestaand element, verandert wat deze
 * functie uitzendt vanzelf; er valt niets te vergeten. Elke ingang draagt een
 * reden in plaats van stilte, precies zoals beeflowTables hierboven WEIGERT in
 * plaats van een lege lijst te geven. In dit bestand staat daarom met opzet
 * GEEN enkele tagnaam — ook niet in commentaar; bfElements.drift.test.js
 * verbiedt dat, want elke naam die hier met de hand staat kan achterlopen.
 *
 * ── EN DE ELEMENTEN FALEN HIER ZICHTBAAR ────────────────────────────
 *
 * Op een react-share draait wél JS, maar de tabelbrug bestaat er niet en de
 * automation-brug is een no-op. Een element dat daarvan afhangt kan hier dus niets,
 * en zonder hulp is dat ONZICHTBAAR: een niet-gedefinieerd custom element is
 * `display:inline` zonder kinderen — een leeg vak. Een lezer ziet dan een lege
 * tabel (die leest als "er zijn geen rijen") of een knop die niets doet zonder
 * te zeggen waarom. Bij de automation-brug is het nog een graadje erger: die
 * RESOLVET, dus een zelfgebouwde knop meldt succes zonder dat er iets gebeurde.
 *
 * Daarom definieert deze brug voor elk GEWEIGERD element een custom element dat
 * zijn eigen weigering toont. De lijst en de tekst komen uit het vocabulaire;
 * hier staat alleen het mechanisme. Dezelfde regel als in de vanilla snapshot,
 * waar de uitklapper vóór DOMPurify een zichtbaar uitgeschakeld blok neerzet:
 * dood mag, stil niet.
 */

const { buildBfNoticeScript, jsonLiteral } = require('./bfBridgeNotices');

function buildPublicBridgeScript({ token, apiBase }) {
    // jsonLiteral, niet JSON.stringify: een `</script>` in een waarde zou de brug
    // in tweeën knippen en alles erna (o.a. beeflowIntegrations) laten verdwijnen.
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
  // run() WEIGERT, net als beeflowTables hieronder en om dezelfde reden. Een
  // no-op die resolvet is hier het gevaarlijkst van allemaal: een zelfgebouwde
  // knop meldt dan "Verzonden!" terwijl er niets is gedraaid. list() mag wel
  // leeg antwoorden — "je mag hier geen automatiseringen opsommen" en "er zijn er geen"
  // komen daar op hetzelfde neer, en paginacode die erover itereert breekt niet.
  function noRun(){ return Promise.reject(new Error("beeflowAutomations.run is not available on shared links")); }
  window.beeflowAutomations = { run:noRun, list:function(){return Promise.resolve([]);} };
  // Tabelbindingen bestaan op een publieke share NIET. Bewust een WEIGERING en
  // geen lege lijst zoals de stubs hierboven: een lege lijst leest als "de
  // tabel heeft geen rijen", en dat is iets anders dan "hier kun je geen tabel
  // lezen". Wat een publieke lezer wel van een tabel te zien krijgt, heeft de
  // snapshot-writer server-side uit publicColumns gerenderd
  // (services/webpageBfTable.js).
  function noTables(){ return Promise.reject(new Error("beeflowTables is not available on shared links")); }
  window.beeflowTables = { query:noTables, insert:noTables, update:noTables };
${buildBfNoticeScript('reactShare')}
  try { window.beeflowIntegrations = new Proxy({}, { get:function(){ return noop; } }); }
  catch(e){ window.beeflowIntegrations = {}; }
})();<\/script>`;
}

module.exports = { buildPublicBridgeScript };
