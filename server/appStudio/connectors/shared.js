/**
 * Connector vocabulary and the stateless helpers every connector kind shares:
 * the runtime caps, the error shape, the safe public projection, viewer-param
 * sanitation, and turning an upstream result into rows. See ../connectors.js
 * for the connector model and the trust rules.
 */

'use strict';

// 'mailbox' reads a Gmail/Outlook mailbox (the viewer's own, or a shared one)
// into an app table. It is a connector rather than a bespoke subsystem so it
// inherits scheduling, watermarking, RLS-safe writes, runAs owner/viewer, the
// viewer connect-prompt UI and the rate limits for free.
const CONNECTOR_KINDS = Object.freeze(['integration_tool', 'automation', 'rest', 'mailbox']);

// Viewer-param hygiene + bounded output. Kept local — these are runtime caps on
// the *viewer* surface, not persisted model limits (those live in dataModel.js).
const MAX_VIEWER_PARAMS = 50;
const MAX_PARAM_KEY_LEN = 100;
const MAX_PARAM_STR_LEN = 2000;
const MAX_CONNECTOR_ROWS = 500;      // hard ceiling on rows returned to a viewer
const REST_TIMEOUT_MS = parseInt(process.env.STUDIO_APP_CONNECTOR_TIMEOUT_MS, 10) || 10_000;
const MAX_REST_BYTES = 4 * 1024 * 1024;

// ── Chain budget ────────────────────────────────────────────────────
// A chain step runs once PER ROW, so 500 rows × 3 steps would be 1500 upstream
// calls made with the OWNER's credentials from a single viewer request. The
// budget is a hard stop, not a hint: when it runs out the remaining rows are
// returned UNENRICHED and flagged, because half a table beats a rate-limit ban
// on the owner's account. MAX_CHAIN_STEPS mirrors the persisted-model cap in
// dataModel.js (kept in lockstep by connectors.chain.test.js).
const MAX_CHAIN_STEPS = 3;
const MAX_CHAIN_CALLS = parseInt(process.env.STUDIO_APP_CHAIN_CALL_BUDGET, 10) || 200;
const MAX_CHAIN_CONCURRENCY = 4;

function connectorError(status, message, code) {
    const err = new Error(message);
    err.status = status;
    if (code) err.code = code;
    return err;
}

// ── Shape helpers ───────────────────────────────────────────────────

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidConnector(c) {
    return isPlainObject(c)
        && typeof c.id === 'string' && c.id.length > 0
        && CONNECTOR_KINDS.includes(c.kind);
}

/** Safe, secret-free projection for the FE (never fixedArgs / url / creds). */
function publicConnector(c) {
    return {
        id: c.id,
        kind: c.kind,
        name: typeof c.name === 'string' && c.name ? c.name : c.id,
        params: Array.isArray(c.params)
            ? c.params
                .filter((p) => isPlainObject(p) && typeof p.key === 'string')
                .map((p) => ({ key: p.key, type: typeof p.type === 'string' ? p.type : 'text', required: !!p.required }))
            : [],
        // Non-secret integration metadata: which app a viewer-mode connector
        // needs, so the runtime can pre-flight "connect Gmail first" UI.
        ...(typeof c.integrationId === 'string' && c.integrationId ? { integrationId: c.integrationId } : {}),
        ...(c.runAs === 'viewer' ? { runAs: 'viewer' } : {}),
    };
}

/**
 * The connectors declared in a data model, as a safe public projection. Reads
 * ONLY model.connectors — the FE never learns an owner's pinned args or creds.
 */
function listConnectors(model) {
    const list = (model && Array.isArray(model.connectors)) ? model.connectors : [];
    return list.filter(isValidConnector).map(publicConnector);
}

/** Resolve a connector by id from the model (own-property, no proto walk). */
function findConnector(model, connectorId) {
    if (!model || !Array.isArray(model.connectors) || typeof connectorId !== 'string') return null;
    return model.connectors.find((c) => isValidConnector(c) && c.id === connectorId) || null;
}

// ── Viewer-param sanitation ─────────────────────────────────────────
// Only primitives cross the boundary; keys/counts/strings are bounded. When
// `allowKeys` is provided, keys outside it are dropped (used for REST, where
// only declared {placeholders} may be filled).
function sanitizeViewerParams(params, allowKeys = null) {
    const src = isPlainObject(params) ? params : {};
    const allow = allowKeys ? new Set(allowKeys) : null;
    const out = {};
    let count = 0;
    for (const [k, v] of Object.entries(src)) {
        if (count >= MAX_VIEWER_PARAMS) break;
        if (typeof k !== 'string' || k.length === 0 || k.length > MAX_PARAM_KEY_LEN) continue;
        if (allow && !allow.has(k)) continue;
        const t = typeof v;
        if (t !== 'string' && t !== 'number' && t !== 'boolean') continue;
        out[k] = t === 'string' ? v.slice(0, MAX_PARAM_STR_LEN) : v;
        count++;
    }
    return out;
}

// The viewer-facing keys a connector declares. For integration_tool this is the
// ALLOW-LIST: an undeclared key must never widen the argument surface of a tool
// call that runs with the OWNER's credentials.
function declaredParamKeys(connector) {
    const list = (connector && Array.isArray(connector.params)) ? connector.params : [];
    return list.filter((p) => isPlainObject(p) && typeof p.key === 'string' && p.key).map((p) => p.key);
}

/**
 * Narrow viewer-supplied params to the connector's declaration before dispatch.
 * Undeclared keys are dropped silently — same contract as the REST placeholder
 * filter. Only integration_tool is narrowed here: REST bounds its own surface to
 * the template's {placeholders}, and an automation's params bag is read
 * explicitly by the owner's automation.
 */
function filterDeclaredParams(connector, params) {
    if (!isPlainObject(params)) return {};
    if (!connector || connector.kind !== 'integration_tool') return params;
    const allow = new Set(declaredParamKeys(connector));
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        if (allow.has(k)) out[k] = v;
    }
    return out;
}

// Envelope keys integrations wrap their lists in. Nothing in this codebase
// normalises tool output — Google returns { results, total }, vPlan
// { data, count, offset, … }, Nextcloud { count, activities } — so a connector
// has to unwrap it or every one of those becomes a SINGLE row holding a blob.
const LIST_ENVELOPE_KEYS = new Set(['rows', 'results', 'data', 'items', 'records', 'list', 'entries', 'values']);

/**
 * Find the row array inside a tool's response envelope.
 *
 * Conservative on purpose: unwrap only when there is exactly ONE array to
 * choose from, and only when it looks like a list of records (objects) or sits
 * under a well-known list key. Two candidate arrays is ambiguous, so the whole
 * payload stays one row rather than us guessing wrong — and an author who hits
 * that can pin `rowsPath` explicitly.
 */
function unwrapListEnvelope(value) {
    if (!isPlainObject(value)) return value;
    if (Array.isArray(value.rows)) return value.rows;          // the pre-existing contract
    const arrays = Object.entries(value).filter(([k, v]) => !k.startsWith('_') && Array.isArray(v));
    if (arrays.length !== 1) return value;
    const [key, arr] = arrays[0];
    if (LIST_ENVELOPE_KEYS.has(key)) return arr;
    // An unknown key still unwraps when the array holds records — that is a list
    // of things, not a scalar attribute like `tags: ['a','b']` on one record.
    if (arr.length > 0 && isPlainObject(arr[0])) return arr;
    return value;
}

// Coerce an external payload into a bounded row array.
function toRows(value, cap = MAX_CONNECTOR_ROWS) {
    let rows;
    if (Array.isArray(value)) rows = value;
    else if (value === null || value === undefined) rows = [];
    else {
        const unwrapped = unwrapListEnvelope(value);
        rows = Array.isArray(unwrapped) ? unwrapped : [unwrapped];
    }
    return rows.slice(0, Math.max(0, cap));
}

// Walk a dot path ('data.items') defensively; own-props only.
function getByPath(obj, path) {
    if (!path || typeof path !== 'string') return obj;
    let cur = obj;
    for (const seg of path.split('.')) {
        if (!seg) continue;
        if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/**
 * Every integration this connector will dispatch: the app it declares, plus the
 * app owning each chain step's tool. Resolved through the same prefix map the
 * runtime uses (core/integrationToolMap), so a chain that reaches into a second
 * app still gets that app's tokens loaded.
 *
 * Falls back to the declared integrationId, then to the tool's own prefix, so a
 * connector authored before integrationId existed still resolves.
 */
function integrationIdsFor(connector) {
    const ids = new Set();
    if (typeof connector?.integrationId === 'string' && connector.integrationId) ids.add(connector.integrationId);

    let resolveIntegration = null;
    try { ({ resolveIntegration } = require('../../core/integrations/integrationToolMap')); } catch { /* optional */ }

    const addForTool = (tool) => {
        if (typeof tool !== 'string' || !tool) return;
        const resolved = resolveIntegration ? resolveIntegration(tool) : null;
        if (resolved?.integration) ids.add(resolved.integration);
    };
    addForTool(connector?.tool);
    for (const step of Array.isArray(connector?.chain) ? connector.chain : []) addForTool(step?.tool);

    return [...ids];
}

module.exports = {
    CONNECTOR_KINDS,
    MAX_CONNECTOR_ROWS,
    REST_TIMEOUT_MS,
    MAX_REST_BYTES,
    MAX_CHAIN_STEPS,
    MAX_CHAIN_CALLS,
    MAX_CHAIN_CONCURRENCY,
    connectorError,
    isPlainObject,
    isValidConnector,
    publicConnector,
    listConnectors,
    findConnector,
    sanitizeViewerParams,
    declaredParamKeys,
    filterDeclaredParams,
    unwrapListEnvelope,
    toRows,
    getByPath,
    integrationIdsFor,
};
