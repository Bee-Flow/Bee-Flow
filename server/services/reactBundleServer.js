// @typecheck
/**
 * Server-side React + Material UI bundle + document assembly.
 *
 * This is the SERVER side of the react-mui preview: it produces the SAME
 * single-inline-module + esm.sh import-map document the web editor's preview
 * renders (agent-hub/src/utils/buildWebpagePreview.ts), but with NATIVE
 * esbuild (not esbuild-wasm) so headless Chromium
 * (server/services/webpageRender.js) can screenshot a react-mui page exactly
 * as the user sees it.
 *
 * The version pins, import map, externalisation rules, virtual-fs resolution,
 * runtime guard, asset resolver and document shell come from ONE module,
 * server/shared/webpage/reactPreview.mjs, which the web side imports through
 * its generated mirror. What stays here is server-only: the native bundler and
 * the stubbed bridge head scripts for the headless render and the public share.
 */

const esbuild = require('esbuild');
const { buildBfNoticeScript } = require('./bfBridgeNotices');
const {
    REACT_ENTRY,
    buildImportMap,
    bundleReact,
    reactBodyHtml,
    shellDoc,
} = require('../shared/webpage/reactPreview.mjs');

/**
 * Bundle the react-mui project (files map) into one ESM string. Throws an Error
 * whose `.formatted` carries readable esbuild diagnostics on failure.
 */
function buildReactBundle({ entry = REACT_ENTRY, files }) {
    return bundleReact(esbuild, { entry, files });
}

/**
 * No-op platform bridges for the HEADLESS render and for a PUBLIC REACT SHARE.
 * The bf-browser is network-isolated from the API, so a page that calls
 * window.beeflowDB/App on mount would hang/throw and render blank. Stub them to
 * resolve to empty data so the page renders its shell/chrome. (NOT the real
 * buildBridgeHeadScripts — that returns '' when tokens are missing, leaving the
 * bridges undefined.)
 *
 * ── THIS IS THE BRIDGE THAT ALWAYS RUNS ────────────────────────────
 *
 * composeReactDoc bakes this into EVERY react document: the public share and the picture the builder AI of the page gets to see. The AI bridge from
 * services/publicBridgeScript.js is only added when the author has turned on public AI, and that is default OFF. That is why the FAIL-HONESTLY
 * mechanism for the bf elements belongs HERE and not there: otherwise on the default path every element is an empty box without a single word of explanation.
 *
 * `surface` says WHICH place this is, because the two contradict each other's sentence: on the author's picture "on a shared link" would be untrue. The texts
 * come from core/webpages/bfElements.js; not a single tag name appears here.
 *
 * @param {string} [surface='headlessRender'] one of bfElements.BRIDGE_SURFACES
 */
function buildStubBridgeScript(surface = 'headlessRender') {
    return `<script>(function(){
  var noop = function(){ return Promise.resolve(); };
  window.beeflowDB = { query:function(){return Promise.resolve([]);}, exec:function(){return Promise.resolve({changes:0});}, batch:function(){return Promise.resolve([]);} };
  window.beeflowApp = { call:function(){return Promise.resolve({});} };
  // All names the two other bridges know, plus the three that only ever
  // existed here. A name missing here is a TypeError on a page that may
  // call it in the other places: exactly the drift this file served as an
  // example of for years.
  function noAsk(){ return Promise.reject(new Error("beeflowAI.ask is not available here")); }
  window.beeflowAI = {
    complete:noop, ground:noop, generate:noop,
    chat:noop, chatJSON:noop, stream:noop, ask:noAsk
  };
  // run() REFUSES, like beeflowTables below: a no-op that RESOLVES lets a
  // hand-built button report success without anything having run.
  function noRun(){ return Promise.reject(new Error("beeflowAutomations.run is not available here")); }
  window.beeflowAutomations = { run:noRun, list:function(){return Promise.resolve([]);} };
  // A refusal, not an empty list: "no rows" and "there is no table bridge
  // here" must stay distinct (see services/publicBridgeScript.js).
  function noTables(){ return Promise.reject(new Error("beeflowTables is not available here")); }
  window.beeflowTables = { query:noTables, insert:noTables, update:noTables };${buildBfNoticeScript(surface)}
  try { window.beeflowIntegrations = new Proxy({}, { get:function(){ return noop; } }); }
  catch(e){ window.beeflowIntegrations = {}; }
})();<\/script>`;
}

/**
 * Compose the full react-mui HTML document for a headless screenshot. Returns
 * { doc } on success, or { buildError } (esbuild diagnostics) on bundle failure.
 *
 * @param {object} opts
 * @param {Object<string,{isText:boolean,content?:string,dataUrl?:string}>} opts.files
 * @param {Object<string,string>} opts.assetMap  path → data: URL for binary assets
 * @param {string} [opts.surface] one of bfElements.BRIDGE_SURFACES (default 'headlessRender')
 * @param {string} [opts.headScripts] replaces the stub bridges — the draft
 *   document (webpageDraftDocument.js) passes the LIVE, token-carrying bridges
 * @param {Function} [opts.build] the bundler, buildReactBundle by default; the
 *   draft document passes a cached one
 */
async function composeReactDoc({ files, assetMap = {}, surface = 'headlessRender', headScripts, build = buildReactBundle }) {
    if (!files[REACT_ENTRY]) {
        return { buildError: `No entry point: ${REACT_ENTRY} is missing. A react-mui project must have src/main.jsx that mounts the app into #root.` };
    }
    let bundle;
    try {
        const r = await build({ entry: REACT_ENTRY, files });
        bundle = r.code;
    } catch (e) {
        return { buildError: e.formatted || e.message || String(e) };
    }
    const bodyHtml = reactBodyHtml({ bundle, assetMap, headless: true });
    const doc = shellDoc({
        headScripts: typeof headScripts === 'string' ? headScripts : buildStubBridgeScript(surface),
        importMap: buildImportMap(),
        bodyHtml,
    });
    return { doc };
}

module.exports = {
    REACT_ENTRY,
    buildReactBundle,
    buildImportMap,
    composeReactDoc,
    buildStubBridgeScript,
};
