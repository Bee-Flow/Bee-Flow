/**
 * The live platform bridges a webpage PREVIEW runs with — the server twin of
 * the bridge head scripts in agent-hub/src/utils/composeWebpageDocument.js.
 *
 * The web editor composes its preview in the browser and bakes a preview token
 * (POST /api/webpages/:id/preview-token) into these scripts, so the page's
 * `window.beeflowDB`, `beeflowAI`, `beeflowAutomations`, `beeflowIntegrations`,
 * `beeflowTables` and `beeflowApp` reach /api/webpages-preview/:id/... with an
 * `Authorization: Bearer` header from the sandboxed, opaque-origin iframe.
 * GET /api/webpages/:id/draft-document (routes/webpages/draftDocument.js)
 * builds the same document on the server for the phone, so the scripts are
 * needed here too.
 *
 * KEEP IN LOCKSTEP with the web file: webpagePreviewBridges.lockstep.test.js
 * compares each function below with its web original, comment lines aside
 * (the web's comments are partly Dutch; these are the English equivalents).
 * These are NOT the stubs in reactBundleServer.buildStubBridgeScript: those
 * serve the public share and the headless screenshot, where no token exists.
 */

'use strict';

function buildBeeflowAuthScript({ dbToken }) {
    const tokenLiteral = JSON.stringify(dbToken);
    return `<script>(function(){
  var TOKEN = ${tokenLiteral};
  // When the server rejects our token (signing secret rotated, expiry, etc.)
  // ask the parent for a fresh one via postMessage. The parent's session can
  // mint a new token; we swap it in and retry the original request once.
  var _refreshPending = null;
  function refreshToken() {
    if (_refreshPending) return _refreshPending;
    _refreshPending = new Promise(function(resolve, reject) {
      var reqId = "tok_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      function onMsg(e) {
        var d = e && e.data;
        if (!d || d.__beeflowTokenResponse !== true || d.requestId !== reqId) return;
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
        _refreshPending = null;
        if (d.token) { TOKEN = d.token; resolve(true); }
        else { reject(new Error(d.error || "token refresh failed")); }
      }
      var timer = setTimeout(function() {
        window.removeEventListener("message", onMsg);
        _refreshPending = null;
        reject(new Error("token refresh timed out"));
      }, 5000);
      window.addEventListener("message", onMsg);
      try { parent.postMessage({ __beeflowTokenRefresh: true, requestId: reqId }, "*"); }
      catch (err) { _refreshPending = null; reject(err); }
    });
    return _refreshPending;
  }
  function stampAuth(init) {
    var next = Object.assign({}, init || {});
    next.headers = Object.assign({}, (init && init.headers) || {});
    next.headers.Authorization = "Bearer " + TOKEN;
    return next;
  }
  async function fetchWithAuth(url, init, retried) {
    var res = await fetch(url, stampAuth(init));
    if (res.status === 401 && !retried) {
      try { await refreshToken(); } catch (_) { return res; }
      return fetchWithAuth(url, init, true);
    }
    return res;
  }
  window.__beeflowAuth = {
    fetchWithAuth: fetchWithAuth,
    getToken: function(){ return TOKEN; }
  };
})();<\/script>`;
}

function buildBeeflowBridgesScript({ dbToken, dbApiBase, dbWebpageId }) {
    if (!dbToken || !dbApiBase || !dbWebpageId) return '';
    const safeBase = String(dbApiBase || '').replace(/\/+$/, '');
    const safeId = encodeURIComponent(dbWebpageId);
    const baseLiteral = JSON.stringify(safeBase);
    const idLiteral = JSON.stringify(safeId);
    return `<script>(function(){
  var BASE = ${baseLiteral} + "/api/webpages-preview/" + ${idLiteral};
  var fetchWithAuth = window.__beeflowAuth.fetchWithAuth;
  function jsonHeaders() { return { "Content-Type": "application/json" }; }
  async function postJson(path, body) {
    var res = await fetchWithAuth(BASE + path, {
      method: "POST",
      headers: jsonHeaders(),
      body: body ? JSON.stringify(body) : undefined
    });
    var json = null;
    try { json = await res.json(); } catch(_) {}
    if (!res.ok) {
      var err = new Error((json && json.error) || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    return json;
  }
  async function getJson(path) {
    var res = await fetchWithAuth(BASE + path, {});
    var json = null;
    try { json = await res.json(); } catch(_) {}
    if (!res.ok) {
      var err = new Error((json && json.error) || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    return json;
  }
  // Parse a fetch ReadableStream of SSE chunks (event: <name>\\ndata: <json>\\n\\n)
  // and dispatch them to a callback. Used by beeflowAI.stream.
  async function streamSSE(path, body, onEvent) {
    var res = await fetchWithAuth(BASE + path, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body || {}) });
    if (!res.ok) {
      var errJson = null;
      try { errJson = await res.json(); } catch(_) {}
      var err = new Error((errJson && errJson.error) || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var parts = buf.split("\\n\\n");
      buf = parts.pop();
      for (var i = 0; i < parts.length; i++) {
        var block = parts[i];
        var ev = "message", data = "";
        var lines = block.split("\\n");
        for (var j = 0; j < lines.length; j++) {
          var line = lines[j];
          if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
          else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
        }
        var parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch(_) {}
        try { onEvent(ev, parsed); } catch(_) {}
      }
    }
  }

  window.beeflowAI = {
    chat: function(prompt, opts) {
      var body = Object.assign({ prompt: prompt }, opts || {});
      return postJson("/ai/chat", body).then(function(r){ return r.text; });
    },
    chatJSON: function(prompt, schema, opts) {
      var body = Object.assign({ prompt: prompt, schema: schema }, opts || {});
      return postJson("/ai/chat", body).then(function(r){ return r.json; });
    },
    stream: function(prompt, onToken, opts) {
      var body = Object.assign({ prompt: prompt }, opts || {});
      var full = "";
      return streamSSE("/ai/stream", body, function(ev, data) {
        if (ev === "content" && data && typeof data.text === "string") {
          full += data.text;
          try { onToken && onToken(data.text); } catch(_) {}
        }
      }).then(function(){ return full; });
    },
    // Agentic. The server-side LLM gets the page's full granted surface
    // (integrations, automations, KB) and runs a multi-round tool loop.
    // The page awaits a single promise; the AI does the orchestration.
    //
    // opts = {
    //   messages?, tier?, maxTokens?, maxRounds?,
    //   onToken?(text)    // every text chunk
    //   onEvent?(name, data)  // every SSE event — use for status pills
    //                         // ('tool_call', 'tool_result', 'done', 'error')
    // }
    // → Promise<{ text, rounds, truncated, toolCalls: [{ id, name, args, result }] }>
    ask: function(prompt, opts) {
      var options = opts || {};
      var body = Object.assign({ prompt: prompt }, options);
      delete body.onToken; delete body.onEvent;
      var full = "";
      var rounds = 0;
      var truncated = false;
      var calls = {};
      return streamSSE("/ai/ask", body, function(ev, data) {
        try { options.onEvent && options.onEvent(ev, data); } catch(_) {}
        if (ev === "text" && data && typeof data.text === "string") {
          full += data.text;
          try { options.onToken && options.onToken(data.text); } catch(_) {}
        } else if (ev === "tool_call" && data && data.id) {
          calls[data.id] = { id: data.id, name: data.name, args: data.args, result: null };
        } else if (ev === "tool_result" && data && data.id) {
          if (!calls[data.id]) calls[data.id] = { id: data.id, name: data.name };
          calls[data.id].result = data.summary;
          calls[data.id].ok = !!data.ok;
        } else if (ev === "done" && data) {
          rounds = data.rounds || 0;
          truncated = !!data.truncated;
        } else if (ev === "error" && data && data.error) {
          throw new Error(data.error);
        }
      }).then(function(){
        var toolCalls = Object.keys(calls).map(function(k){ return calls[k]; });
        return { text: full, rounds: rounds, truncated: truncated, toolCalls: toolCalls };
      });
    }
  };

  window.beeflowAutomations = {
    list: function(){ return getJson("/automations").then(function(r){ return r.automations || []; }); },
    run: function(automationId, inputs, opts) {
      var body = { inputs: inputs || {}, wait: !opts || opts.wait !== false };
      return postJson("/automations/" + encodeURIComponent(automationId) + "/run", body);
    },
    getRun: function(runId){ return getJson("/automations/runs/" + encodeURIComponent(runId)); },
    getSteps: function(runId){ return getJson("/automations/runs/" + encodeURIComponent(runId) + "/steps").then(function(r){ return r.steps || []; }); },
    cancel: function(runId){ return postJson("/automations/runs/" + encodeURIComponent(runId) + "/cancel", {}); }
  };

  window.beeflowIntegrations = {
    list: function(){ return getJson("/integrations").then(function(r){ return r.integrations || []; }); },
    run: function(tool, args){ return postJson("/integrations/run", { tool: tool, args: args || {} }); }
  };

  // Studio tables (W3). UNLIKE THE REST ABOVE: these calls run server-side as
  // the SIGNED-IN VISITOR, not as the author — a datatable grants per person.
  // What the page gets back is also cut down to the columns the author bound
  // to this table, plus id and updated_at. The table and every column must be
  // bound; writing needs a 'readwrite' binding.
  //
  // Does NOT exist on a public share: /w/<slug> is a script-free snapshot, so
  // code that leans on this must cope with a missing window.beeflowTables.
  window.beeflowTables = {
    // opts: { filters?, match?, sort?, limit?, cursor? } — filters and sort
    // may only name bound columns, otherwise the server answers 400.
    // Resolves to { rows, hasMore, count, nextCursor, columns }.
    query: function(datatableId, opts){
      return postJson("/tables/" + encodeURIComponent(datatableId) + "/query", opts || {});
    },
    insert: function(datatableId, values){
      return postJson("/tables/" + encodeURIComponent(datatableId) + "/insert", { values: values || {} });
    },
    // expectedUpdatedAt is the updated_at you read: without it the server
    // refuses, so two visitors never silently overwrite each other's change.
    update: function(datatableId, rowId, values, expectedUpdatedAt){
      return postJson("/tables/" + encodeURIComponent(datatableId) + "/update", {
        rowId: rowId, values: values || {}, expectedUpdatedAt: expectedUpdatedAt
      });
    }
  };

  // Light-tier backend: call your own api/<route>.js handler. Resolves to the
  // handler's JSON body; rejects (with .status) on a non-2xx response.
  window.beeflowApp = {
    call: function(route, body, opts){
      var method = (opts && opts.method) || "POST";
      var path = "/app/" + String(route || "").replace(/^\\/+/, "");
      if (method === "GET") return getJson(path);
      return postJson(path, body);
    }
  };
})();<\/script>`;
}

function buildBeeflowDbScript({ dbApiBase, dbWebpageId }) {
    const safeBase = String(dbApiBase || '').replace(/\/+$/, '');
    const safeId = encodeURIComponent(dbWebpageId);
    const baseLiteral = JSON.stringify(safeBase);
    return `<script>(function(){
  var BASE = ${baseLiteral} + "/api/webpages-preview/${safeId}/db";
  var fetchWithAuth = window.__beeflowAuth.fetchWithAuth;
  async function call(path, body, method){
    var res = await fetchWithAuth(BASE + path, {
      method: method || "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    var json = null;
    try { json = await res.json(); } catch(_) {}
    if (!res.ok) {
      var err = new Error((json && json.error) || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    return json;
  }
  window.beeflowDB = {
    query:  function(sql, params){ return call("/query", { sql: sql, params: params || [] }); },
    exec:   function(sql, params){ return call("/exec",  { sql: sql, params: params || [] }); },
    batch:  function(statements){  return call("/batch", { statements: statements }); },
    schema: function(){            return call("/schema", null, "GET"); }
  };
})();<\/script>`;
}
/**
 * The combined auth + DB + AI/automations/integrations/tables/app bridges.
 * Returns '' when any of (token, base, id) is missing, as on the web.
 */
function buildBridgeHeadScripts({ dbToken, dbApiBase, dbWebpageId }) {
    if (!dbToken || !dbApiBase || !dbWebpageId) return '';
    return buildBeeflowAuthScript({ dbToken })
        + buildBeeflowDbScript({ dbApiBase, dbWebpageId })
        + buildBeeflowBridgesScript({ dbToken, dbApiBase, dbWebpageId });
}

module.exports = {
    buildBridgeHeadScripts,
    // test/lockstep
    _internals: { buildBeeflowAuthScript, buildBeeflowBridgesScript, buildBeeflowDbScript },
};
