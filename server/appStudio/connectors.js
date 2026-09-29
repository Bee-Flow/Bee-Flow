/**
 * App Studio v2 — CONNECTORS (owner-authored external data sources).
 *
 * A connector is an allow-listed external data source that an app's OWNER wires
 * up in the data model. Viewers of a published app can *run* a connector to pull
 * rows, but the fetch always executes ACTS-AS-OWNER — with the owner's
 * credentials, quota and pinned arguments — exactly like the action-run bridge
 * (routes/studioAppsRun.js) and the webpage integration bridge
 * (routes/webpagesPreview.js). The viewer's identity rides along for audit
 * (`_viewerUserId`) but never scopes the call.
 *
 * ── OWNER-SCOPED DATA (no RLS 'own') ────────────────────────────────
 * Connector rows come from an EXTERNAL system, so there is no per-row
 * `created_by` column and the RLS gateway's row-level 'own' scope does NOT
 * apply. The owner narrows what a viewer can see by PINNING arguments
 * (`fixedArgs` for tools, a fixed URL template for REST): fixed args always win
 * over viewer-supplied params. Treat every connector result as owner-scoped —
 * only expose a connector whose pinned surface is safe to share with the app's
 * whole audience.
 *
 * Three kinds:
 *   • integration_tool — dispatch a platform tool (Gmail, Sheets, …) via
 *     toolDispatcher.executeTool with the owner's session; the connector's
 *     declared `params` are the allow-list for viewer input (undeclared keys are
 *     dropped) and author fixedArgs always override what survives. An optional
 *     CHAIN runs follow-up tools once per row, binding their parameters to
 *     fields of the row ("read each message search found, then fetch each
 *     attachment read found"). See the chain caps below: depth multiplies calls
 *     made with the OWNER's credentials, so the budget is enforced, not advised.
 *   • automation       — trigger one of the owner's routines
 *     (automationRunner.executeAutomation) after an owner-ownership check.
 *   • rest             — server-side https-only GET of an owner-defined,
 *     allow-listed URL TEMPLATE. Viewer params only fill declared {placeholders}
 *     (URL-encoded); the host is fixed by the template and re-verified; the
 *     target is SSRF-screened (no private/internal addresses); creds come from
 *     the owner's credential store. A client-supplied URL is NEVER fetched.
 *
 * Public API:
 *   listConnectors(model)  → safe projection of model.connectors (no secrets)
 *   runConnector(connector, { app, viewerId, params }) → { rows, nextPage? }
 *   filterDeclaredParams(connector, params) → params narrowed to the connector's
 *                            declaration (edge-level twin of the runtime filter)
 *
 * CONNECTOR SHAPE (stored on model.connectors[]):
 *   {
 *     id: 'conn_<hex>',
 *     kind: 'integration_tool' | 'automation' | 'rest',
 *     name: 'Recent emails',
 *     params?: [{ key, type?, required? }],   // viewer-facing param declarations
 *
 *     // integration_tool
 *     tool: 'gmail_list_messages',
 *     fixedArgs?: { labelIds: ['INBOX'] },    // author-pinned; ALWAYS wins
 *     integrationId?: 'gmail',                // owning app (logo/labels/connection checks)
 *     runAs?: 'owner' | 'viewer',             // default 'owner' (acts-as-owner);
 *                                             // 'viewer' runs with the CALLING
 *                                             // user's connection (409
 *                                             // connection_required when absent)
 *     chain?: [{                              // follow-up actions, one call PER ROW
 *       tool: 'gmail_read',
 *       argsFrom?: { messageId: 'id' },       // param ← path on the CURRENT row
 *       fixedArgs?: { format: 'full' },       // pinned; still always wins
 *       expand?: 'attachments',               // fan out: one row per element
 *       merge?: 'extend' | 'nest',            // default 'extend'
 *       alias?: 'message',                    // required for 'nest'
 *     }],
 *
 *     // materialisation (runtime state lives in studio_app_connector_sync)
 *     sync?: { tableId, mode, keyField, incremental, schedule, refreshOnView },
 *
 *     // automation
 *     automationId: 'auto-123',
 *
 *     // rest
 *     url: 'https://api.example.com/items?q={query}&page={page}',
 *     headers?: { 'X-Api-Version': '2' },     // owner static headers
 *     auth?: { type: 'bearer'|'header', header?: 'X-Api-Key', credentialProvider: 'example' },
 *     rowsPath?: 'data.items',                // dot path to the array
 *     nextPagePath?: 'data.next_cursor',      // dot path to a next-page token
 *     maxRows?: 100,
 *   }
 */

'use strict';
const log = require('../telemetry/log');

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
 * explicitly by the owner's routine.
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
    try { ({ resolveIntegration } = require('../core/integrations/integrationToolMap')); } catch { /* optional */ }

    const addForTool = (tool) => {
        if (typeof tool !== 'string' || !tool) return;
        const resolved = resolveIntegration ? resolveIntegration(tool) : null;
        if (resolved?.integration) ids.add(resolved.integration);
    };
    addForTool(connector?.tool);
    for (const step of Array.isArray(connector?.chain) ? connector.chain : []) addForTool(step?.tool);

    return [...ids];
}

/**
 * The OAuth provider behind an integration id, used as buildUserAuth's
 * providerHint. Without it, a user who has connected BOTH Google and Microsoft
 * gets whichever `Object.entries` happened to yield first as the session's
 * primary accessToken — so a Gmail connector could be handed a Microsoft token.
 */
function providerFor(integrationId) {
    if (!integrationId) return null;
    try {
        const { providersForIntegrations } = require('../auth/routineAuth');
        return providersForIntegrations([integrationId])[0] || null;
    } catch { return null; }
}

// ── Headless user session (mirrors core/webpageBridgeAuth.buildAuthorSession) ─
// Duplicated rather than imported so connectors keep working if that module
// changes shape — same rationale as the webpage bridge duplicating the runner's
// resolveUserSession. Builds a session shim for ANY user id: the app OWNER for
// the default acts-as-owner path, or the calling VIEWER (or a lending grantor)
// for runAs:'viewer' connectors. Test code overrides via _deps.buildOwnerSession
// / _deps.buildUserSession.
//
// `include` carries the integrations this session is ABOUT TO DISPATCH, so the
// provider list can never be empty for the one call that needs it. That is not
// a convenience: an empty list makes routineAuth.buildUserAuth take its
// `required.length === 0` shortcut, which returns a TRUTHY object with a null
// accessToken — and the Google client then reports a connected account as "not
// connected". See core/enabledIntegrations.js for the full trap.
async function defaultBuildUserSession(userId, fallbackOrgId = null, { include = [], providerHint = null } = {}) {
    const userStore = require('../stores/userStore');
    const routineAuth = require('../auth/routineAuth');
    const { resolveEnabledIntegrations } = require('../core/integrations/enabledIntegrations');
    const user = await userStore.getUser(userId).catch(() => null);
    const orgId = user?.organizationId || fallbackOrgId || null;

    let enabled = include;
    try {
        enabled = await resolveEnabledIntegrations(userId, orgId, { include });
    } catch { /* best-effort — `include` alone still covers the dispatched tool */ }

    // `groups` rides along so viewer-mode grant resolution can honor
    // group-scoped lends (resolveConnectionForRun's runningUserGroups).
    const shimUser = {
        id: userId,
        email: user?.email || null,
        organizationId: orgId,
        role: user?.role || null,
        groups: Array.isArray(user?.groups) ? user.groups : [],
    };
    try {
        const built = await routineAuth.buildUserAuth(userId, { enabledIntegrations: enabled, providerHint });
        // `built.accessToken` — NOT just `built`. buildUserAuth answers with a
        // token-less shim when it was asked for no OAuth providers, and adopting
        // that as a session is what turns a working connection into "not
        // connected" three layers downstream.
        if (built?.accessToken) {
            return {
                user: shimUser,
                isAdmin: !!user?.isAdmin,
                accessToken: built.accessToken,
                refreshToken: built.refreshToken,
                expiresAt: built.expiresAt,
                oauthProvider: built.oauthProvider,
                routineProviders: built.routineProviders || {},
            };
        }
    } catch (err) {
        log.warn(`[Connectors] buildUserAuth failed for user ${userId}: ${err.message}`);
    }

    // Legacy session fallback — the same backstop the runner
    // (automationRunner/engine.js) and the webpage bridge both keep. A user who
    // signed in with Google this session has usable tokens on their session row
    // even when the vault has nothing.
    if (process.env.ROUTINE_AUTH_LEGACY !== '0') {
        try {
            const { pool } = require('../db');
            const { rows } = await pool.query(
                `SELECT sess FROM user_sessions
                 WHERE sess::jsonb -> 'user' ->> 'id' = $1
                   AND expire > NOW()
                 ORDER BY expire DESC LIMIT 1`,
                [userId],
            );
            if (rows.length > 0) {
                const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
                if (sess?.accessToken) return sess;
            }
        } catch (err) {
            log.warn(`[Connectors] legacy session lookup failed for user ${userId}: ${err.message}`);
        }
    }

    // Bare shim — non-OAuth tools still run; OAuth ones surface "not connected".
    return {
        user: shimUser,
        isAdmin: !!user?.isAdmin,
        routineProviders: {},
    };
}

async function defaultBuildOwnerSession(app, opts = {}) {
    return defaultBuildUserSession(app.userId, app.organizationId || null, opts);
}

// Default dependency graph — lazily required so this module can be loaded
// (and unit-tested) without pulling the whole runner/store graph. Every entry
// is overridable via `_deps` on the runConnector opts (test-only seam).
function defaultDeps() {
    return {
        executeTool: (...a) => require('../core/tools/toolDispatcher').executeTool(...a),
        executeAutomation: (...a) => require('../core/automationRunner').executeAutomation(...a),
        getAutomation: (...a) => require('../stores/automationStore').getAutomation(...a),
        deriveFinalOutput: (...a) => require('./actionExecutor').deriveFinalOutput(...a),
        // getProviderAuth, NOT the raw store read: it refreshes a token with
        // less than five minutes left and refuses a credential that is revoked
        // or needs re-auth. A raw getCredential handed back a stale access
        // token, so every REST connector on a short-lived provider (Withings
        // expires in 3 h) died silently once the first token aged out.
        getProviderAuth: (...a) => require('../auth/routineAuth').getProviderAuth(...a),
        safeFetch: (...a) => require('../utils/ssrfGuard').safeFetch(...a),
        isPrivateTarget: (...a) => require('../utils/isPrivateTarget').isPrivateTarget(...a),
        buildOwnerSession: defaultBuildOwnerSession,
        buildUserSession: defaultBuildUserSession,
        getIntegrationTools: (...a) => require('../core/integrations/integrationTools').getIntegrationTools(...a),
        resolveConnectionForRun: (...a) => require('../stores/integrationConnectionStore').resolveConnectionForRun(...a),
    };
}

// ── Kind runners ────────────────────────────────────────────────────

/**
 * Resolve WHO a runAs:'viewer' integration_tool connector executes as.
 *
 *   1. The viewer's own resolved tool set (core/integrationTools — the same
 *      strict org ∩ group ∩ toggle ∩ credentials gate the catalog and runtime
 *      use) contains the tool → run as the viewer.
 *   2. Else an applicable LEND grant for the connector's integration
 *      (integrationConnectionStore.resolveConnectionForRun, scoped to this
 *      studio app) → run as the grantor with THEIR session.
 *   3. Else → 409 connection_required (err.provider names the integration so
 *      the client can render "connect <app> first").
 */
async function resolveViewerExecution(connector, { app, viewerId, deps }) {
    if (!viewerId || typeof viewerId !== 'string') {
        throw connectorError(401, 'sign in to use this data source', 'connection_required');
    }
    const provider = (typeof connector.integrationId === 'string' && connector.integrationId) ? connector.integrationId : null;
    // Same `include` the owner path uses — a viewer-mode connector must not fail
    // for the config reason the owner path used to.
    const sessionOpts = { include: integrationIdsFor(connector), providerHint: providerFor(provider) };

    const session = await deps.buildUserSession(viewerId, app.organizationId || null, sessionOpts);
    try {
        // enabledAppsOverride: the viewer's enabled-apps list is a CHAT
        // preference, not an authorization layer — a configured connector must
        // not fail because the viewer never toggled the app on in the
        // composer. Entitlement + credential gates stay authoritative (same
        // rule as mailboxIdentity.viewerHasIntegration).
        const resolved = await deps.getIntegrationTools({
            userId: viewerId, session, isAdmin: !!session?.isAdmin, routineStep: true,
            enabledAppsOverride: integrationIdsFor(connector),
        });
        const names = new Set((resolved?.tools || []).map((t) => t?.function?.name).filter(Boolean));
        if (names.has(connector.tool)) return { userId: viewerId, session };
    } catch { /* fall through to the grant check */ }

    if (provider) {
        const grant = await deps.resolveConnectionForRun({
            runningUserId: viewerId,
            runningUserOrgId: session?.user?.organizationId || app.organizationId || null,
            runningUserGroups: session?.user?.groups || [],
            provider,
            resourceType: 'studio_app',
            resourceId: app.id,
        }).catch(() => null);
        if (grant?.available && grant.mode === 'delegated' && grant.effectiveUserId) {
            const grantorSession = await deps.buildUserSession(grant.effectiveUserId, app.organizationId || null, sessionOpts);
            return { userId: grant.effectiveUserId, session: grantorSession };
        }
    }

    const err = connectorError(409, 'this data source needs a connected account', 'connection_required');
    if (provider) err.provider = provider;
    throw err;
}

/**
 * Read a field off a row for a chain binding. Supports the `a.b` and `a[].b`
 * paths the model allows; `[]` on a leaf yields the array itself (the caller
 * decides whether to fan out over it). Own-props only, no proto walk.
 */
function readRowPath(row, path) {
    if (!isPlainObject(row) || typeof path !== 'string' || !path) return undefined;
    let cur = row;
    for (const rawSeg of path.split('.')) {
        const seg = rawSeg.endsWith('[]') ? rawSeg.slice(0, -2) : rawSeg;
        if (!seg) continue;
        if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/**
 * "You never connected this app" — the one upstream failure that is a SETUP
 * problem rather than a fault, and the only one the UI can offer a fix for.
 *
 * Integration executors disagree about how they report it: most return a soft
 * `{ error }`, but the Google and Microsoft clients THROW a plain Error
 * (integrations/googleClient.js), and the key-based ones say "not configured".
 * Left unclassified, a throw carries no status and the route collapses it to a
 * generic 500 — the author sees "Connector failed to run" and has nothing to act
 * on. Recognising it here turns all of those into the 409 `connection_required`
 * the client already renders as "Connect <app> first".
 */
const MISSING_CONNECTION_RE = /not connected|must log in|not configured|no (?:valid )?(?:credentials|token|api key)|connect (?:it |your account )?(?:via|in) settings|authenticat|unauthoriz|invalid_grant/i;

/**
 * Build the 409 — but first check whether the account IS connected.
 *
 * "Not connected to Gmail" from the upstream client means only that the SESSION
 * carried no token. That has two very different causes, and telling a user to
 * connect an app they already connected sends them in a circle:
 *
 *   • no active credential in the vault → they really do need to connect it;
 *   • an active credential exists but the session didn't carry it → OUR fault,
 *     and no amount of clicking "Connect" will fix it, so say something else and
 *     log it as the server-side defect it is.
 *
 * `code` stays `connection_required` either way so existing clients keep working;
 * `reason` distinguishes them for a caller that wants to.
 */
async function connectionError(connector, message, { userId, deps: _deps } = {}) {
    const provider = (typeof connector?.integrationId === 'string' && connector.integrationId) ? connector.integrationId : null;
    let hasCredential = false;
    if (userId && provider) {
        try {
            const oauthProvider = providerFor(provider);
            if (oauthProvider) {
                const { getProviderAuth } = require('../auth/routineAuth');
                hasCredential = !!(await getProviderAuth(userId, oauthProvider))?.accessToken;
            }
        } catch { /* fall back to the plain "connect it" message */ }
    }

    if (hasCredential) {
        log.warn(`[Connectors] ${provider} is connected for user ${userId} but the connector session carried no token — upstream said: ${String(message).slice(0, 200)}`);
        const err = connectorError(409, `Your ${provider} connection could not be loaded. Try disconnecting and reconnecting it in Settings → Integrations.`, 'connection_required');
        err.reason = 'token_unavailable';
        if (provider) err.provider = provider;
        return err;
    }

    const err = connectorError(409, String(message).slice(0, 300), 'connection_required');
    err.reason = 'not_connected';
    if (provider) err.provider = provider;
    return err;
}

/**
 * Run one tool call for a resolved identity. Soft `{error}` results and thrown
 * executor errors both surface as structured connector errors — a missing
 * connection as 409, anything else as 502.
 */
async function dispatchTool(tool, args, exec, deps, app, connector) {
    let result;
    try {
        result = await deps.executeTool(tool, args, {
            userId: exec.userId,
            session: exec.session,
            orgId: exec.orgId ?? (app.organizationId || null),
            autoSend: true,                   // headless / unattended dispatch
            // A data source of a Studio app: the dispatcher's chokepoint
            // writes the egress row under the identity it ran as.
            egress: {
                source: 'studio_app',
                ids: {
                    organization_id: exec.orgId ?? (app.organizationId || null),
                    user_id: exec.userId || null,
                    agent_name: `App: ${app.name || 'Untitled app'}`,
                },
            },
        });
    } catch (err) {
        if (Number.isInteger(err?.status)) throw err;          // already classified
        const message = String(err?.message || err);
        if (MISSING_CONNECTION_RE.test(message)) throw await connectionError(connector, message, { userId: exec.userId, deps });
        throw connectorError(502, message.slice(0, 300), 'connector_failed');
    }
    if (result && typeof result === 'object' && result.error) {
        const message = String(result.error);
        if (MISSING_CONNECTION_RE.test(message)) throw await connectionError(connector, message, { userId: exec.userId, deps });
        throw connectorError(502, message.slice(0, 300), 'connector_failed');
    }
    return result;
}

// Run `jobs` with a small fixed concurrency. Deliberately hand-rolled rather
// than Promise.all over everything: an owner's Gmail account must not receive
// 500 simultaneous reads because their app has 500 rows.
async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

/**
 * Apply one chain step to every row: call `step.tool` once per row with its
 * parameters bound to that row, then fold the result back in.
 *
 *   merge 'extend' — spread the result's own fields onto the row. On a key
 *                    collision the incoming field is prefixed with the tool's
 *                    short name, so a follow-up can never silently overwrite the
 *                    identity or watermark the sync engine depends on.
 *   merge 'nest'   — put the whole result under `row[alias]`.
 *   expand         — fan out: one output row per element of that field, which is
 *                    how "one row per attachment" is expressed.
 *   ownTable       — the step's result is a THING OF ITS OWN, stored beside the
 *                    parent rather than widening it: one child row per parent
 *                    row, joined by a relation column. Only affects the traced
 *                    per-grain view; the flat output stays merged either way.
 *
 * A single row's failure is recorded on that row (`_error`) instead of failing
 * the run: one unreadable message must not empty a table of 400 good ones. The
 * BASE step has no such tolerance — it still throws (see runIntegrationChain).
 */
async function applyChainStep(step, rows, budget, exec, deps, app, connector, {
    trace = false, grainRows = null, rowGrainIndex = null,
} = {}) {
    const tool = typeof step.tool === 'string' ? step.tool : '';
    if (!tool) return rows;
    const argsFrom = isPlainObject(step.argsFrom) ? step.argsFrom : {};
    const fixedArgs = isPlainObject(step.fixedArgs) ? step.fixedArgs : {};
    const merge = step.merge === 'nest' ? 'nest' : 'extend';
    const alias = typeof step.alias === 'string' && step.alias ? step.alias : tool.split('_').pop();
    const shortName = tool.split('_').slice(1).join('_') || tool;

    // Fan out over a field of the result (attachments), or keep the result as a
    // thing of its own beside the parent. Both open a new grain — a table of
    // their own — so they are decided once, not per row.
    const expandFrom = typeof step.expand === 'string' && step.expand ? step.expand : null;
    const ownTable = step.ownTable === true && !expandFrom;
    const opensChildGrain = !!expandFrom || ownTable;

    const results = await mapWithConcurrency(rows, MAX_CHAIN_CONCURRENCY, async (row) => {
        if (!isPlainObject(row)) return { row, result: null };
        // A row the previous step could not resolve is missing exactly the fields
        // this one binds from, so calling the tool for it would spend an upstream
        // call to learn nothing. It is carried through with its reason intact
        // rather than dropped — the author still sees which rows failed and why.
        if (row._error) return { row, result: null, carried: true };
        if (budget.remaining <= 0) return { row, result: null, skipped: true };
        budget.remaining -= 1;

        const bound = {};
        for (const [param, path] of Object.entries(argsFrom)) {
            const value = readRowPath(row, path);
            if (value === undefined || value === null) continue;
            // Only primitives cross into a tool call; an object would be a
            // silently malformed argument.
            if (typeof value === 'object') continue;
            bound[param] = value;
        }
        // Pinned args still win, exactly as on the base step.
        const args = { ...bound, ...fixedArgs };
        try {
            return { row, result: await dispatchTool(tool, args, exec, deps, app, connector) };
        } catch (err) {
            // A missing connection is a setup problem, not a bad row — stamping
            // it on 500 rows would hide the one thing the author can fix.
            if (err?.code === 'connection_required') throw err;
            return { row, result: null, error: String(err?.message || err).slice(0, 200) };
        }
    });

    const out = [];
    // In trace mode we additionally keep the rows at each GRAIN: `parentOut` is
    // the incoming grain with this step's enrichment applied in place, `childOut`
    // the rows of the grain this step opens. Those two are what a related pair of
    // tables is stored from — the flat `out` would duplicate every parent field
    // once per child.
    //
    // parentOut starts as a COPY of the incoming grain and is updated by grain
    // index, never rebuilt row-by-row from the flat output: after an expand the
    // flat rows outnumber their grain, so appending per flat row would grow the
    // parent table by one junk row per child.
    const baseGrain = grainRows || rows;
    const parentOut = trace ? baseGrain.slice() : null;
    const childOut = (trace && opensChildGrain) ? [] : null;
    // out[i] → its index in the grain that is CURRENT after this step. Tracked
    // explicitly rather than assumed positional: a row that errored, that was
    // skipped for budget, or that expanded over an empty list still produces a
    // flat row but no grain row, and from there on every later step would bind
    // against the wrong parent.
    const grainIndexOf = trace ? [] : null;
    const pushOut = (flatRow, grainIdx) => {
        out.push(flatRow);
        if (grainIndexOf) grainIndexOf.push(grainIdx);
    };

    for (const [parentIndex, entry] of results.entries()) {
        const { row, result, error, skipped, carried } = entry;
        // The row as its GRAIN holds it — free of the parent columns the flat
        // view carries — so enriching a child grain doesn't re-import them.
        const grainAt = rowGrainIndex ? (rowGrainIndex[parentIndex] ?? -1) : parentIndex;
        const grainRow = (grainRows && grainAt >= 0 && grainRows[grainAt]) || row;
        // A row that produced nothing has no place in the child grain, so it maps
        // to -1; the parent grain still gets its entry, carrying the reason.
        const noChild = opensChildGrain ? -1 : grainAt;
        // Already failed upstream: the grain entry keeps the reason the earlier
        // step wrote there, so nothing to update here.
        if (carried) { pushOut(row, noChild); continue; }
        if (skipped) { pushOut({ ...row, _partial: true }, noChild); if (trace && grainAt >= 0) parentOut[grainAt] = { ...grainRow, _partial: true }; continue; }
        if (error) { pushOut({ ...row, _error: error }, noChild); if (trace && grainAt >= 0) parentOut[grainAt] = { ...grainRow, _error: error }; continue; }

        const expandSource = expandFrom
            ? (readRowPath(isPlainObject(result) ? result : {}, expandFrom) ?? readRowPath(row, expandFrom))
            : null;

        // Who owns a colliding key depends on what the step did.
        //
        //   enrich (no expand) — the ROW keeps its own fields; the result's
        //     collisions are prefixed with the tool. Enrichment must never
        //     overwrite the identity or watermark a sync depends on.
        //   expand            — the ELEMENT is the new row's subject (fanning
        //     out over attachments makes each row an attachment), so its fields
        //     win and the parent's collisions are preserved as `parent_<key>`.
        //     That is also what makes the next step bindable: `id` is the
        //     attachment, `parent_id` is still the message.
        const foldOnto = (base, payload, fromExpand) => {
            if (merge === 'nest') return { ...base, [alias]: payload ?? null };
            if (!isPlainObject(payload)) return { ...base, [alias]: payload ?? null };
            const merged = { ...base };
            for (const [k, v] of Object.entries(payload)) {
                if (!Object.hasOwn(base, k)) { merged[k] = v; continue; }
                if (fromExpand) { merged[`parent_${k}`] = base[k]; merged[k] = v; }
                else { merged[`${shortName}_${k}`] = v; }
            }
            return merged;
        };

        if (expandFrom && Array.isArray(expandSource)) {
            // An expanding step still returns fields ABOUT THE PARENT alongside
            // the list — gmail_read hands back the body as well as the
            // attachments. Those belong on the parent, so they are folded there
            // rather than dropped (they used to be) or copied onto every child.
            const rest = isPlainObject(result)
                ? Object.fromEntries(Object.entries(result).filter(([k]) => k !== expandFrom))
                : null;
            const enrichedParent = rest && Object.keys(rest).length ? foldOnto(row, rest, false) : row;
            if (trace && grainAt >= 0 && rest && Object.keys(rest).length) {
                parentOut[grainAt] = foldOnto(grainRow, rest, false);
            }

            if (expandSource.length === 0) { pushOut(enrichedParent, -1); continue; }
            for (const item of expandSource) {
                const element = isPlainObject(item) ? item : { [expandFrom]: item };
                let childIdx = -1;
                if (trace) {
                    // The CHILD grain is the element and nothing else. Copying the
                    // parent's columns onto it is exactly the duplication that
                    // related tables exist to avoid — the link is the relation
                    // column, resolved from `_parentIndex` at write time.
                    // Leading underscore → inferFields and the column mapper
                    // both ignore it.
                    childIdx = childOut.push({ ...element, _parentIndex: grainAt }) - 1;
                }
                // The FLAT view stays merged: a grid bound straight to the
                // connector wants one wide row, and the next chain step binds
                // against `parent_<key>`.
                pushOut(foldOnto(enrichedParent, element, true), childIdx);
                if (out.length >= MAX_CONNECTOR_ROWS) break;
            }
        } else if (ownTable) {
            // The result is its own thing, kept beside the parent instead of
            // widening it: one child row per parent row. The parent grain is left
            // exactly as it was — that is the whole point, otherwise the same
            // columns would live in two tables.
            let childIdx = -1;
            if (trace) {
                // parentOut[grainAt] is already the untouched grain row.
                const element = isPlainObject(result) ? { ...result } : { [alias]: result ?? null };
                element._parentIndex = grainAt;
                childIdx = childOut.push(element) - 1;
            }
            // The flat view still merges, so `Test it`, a grid bound straight to
            // the connector, and a later step's bindings behave as before.
            pushOut(foldOnto(row, result, false), childIdx);
        } else {
            // `_parentIndex`, when the grain row carries one, survives the fold —
            // it is on the base, not the payload.
            if (trace && grainAt >= 0) parentOut[grainAt] = foldOnto(grainRow, result, false);
            pushOut(foldOnto(row, result, false), grainAt);
        }
        if (out.length >= MAX_CONNECTOR_ROWS) break;
    }
    const capped = out.slice(0, MAX_CONNECTOR_ROWS);
    if (!trace) return capped;
    return {
        rows: capped,
        parentRows: parentOut,
        childRows: (childOut && childOut.length) ? childOut.slice(0, MAX_CONNECTOR_ROWS) : null,
        grainIndexOf: grainIndexOf.slice(0, capped.length),
    };
}

async function runIntegrationTool(connector, { app, viewerId, params, systemArgs, trace, deps }) {
    const tool = typeof connector.tool === 'string' ? connector.tool : '';
    if (!tool) throw connectorError(400, 'connector has no tool', 'bad_connector');

    const viewerParams = sanitizeViewerParams(params, declaredParamKeys(connector));
    const fixedArgs = isPlainObject(connector.fixedArgs) ? connector.fixedArgs : {};
    // systemArgs are SERVER-ORIGIN arguments (today: the incremental sync's
    // since-param). They are never reachable from an HTTP body — runConnector's
    // only callers that set them are internal — so they sit above viewer input
    // but still BELOW the author's pins, which keep the last word.
    const system = isPlainObject(systemArgs) ? sanitizeViewerParams(systemArgs) : {};
    // Author-pinned fixedArgs ALWAYS win — spread last (same as the webpage
    // integration bridge). The owner keeps control of sensitive fields.
    const mergedArgs = { ...viewerParams, ...system, ...fixedArgs };

    // runAs:'viewer' → the CALLING user's connection (or a lend grant);
    // otherwise the default acts-as-owner path. Resolved ONCE and reused for
    // every chain call: re-negotiating per row would re-check grants hundreds of
    // times and could even change identity mid-run.
    const asViewer = connector.runAs === 'viewer';
    // The integrations this run will actually dispatch — the base tool plus every
    // chain step. Handing these to the session builder is what guarantees their
    // provider tokens get loaded regardless of how the org's integration lists
    // happen to be configured.
    const integrationIds = integrationIdsFor(connector);
    const resolved = asViewer
        ? await resolveViewerExecution(connector, { app, viewerId, deps })
        : {
            userId: app.userId,
            session: await deps.buildOwnerSession(app, {
                include: integrationIds,
                providerHint: providerFor(integrationIds[0]),
            }),
        };
    const exec = {
        ...resolved,
        orgId: (asViewer
            ? resolved.session?.user?.organizationId || app.organizationId
            : app.organizationId || resolved.session?.user?.organizationId) || null,
    };

    // Base step — a failure here is the connector failing, so it throws.
    // An explicit rowsPath wins over the envelope heuristic: it is the escape
    // hatch for a payload with more than one candidate list.
    const raw = await dispatchTool(tool, mergedArgs, exec, deps, app, connector);
    let rows = toRows(connector.rowsPath ? getByPath(raw, connector.rowsPath) : raw);

    const chain = Array.isArray(connector.chain) ? connector.chain.slice(0, MAX_CHAIN_STEPS) : [];
    if (!chain.length) return { rows, ...(trace ? { grains: [{ level: 0, tool, rows }] } : {}) };

    // ── GRAINS ──────────────────────────────────────────────────────
    // A step that EXPANDS changes what one row means: after "one row per
    // attachment", the message-level rows no longer exist in the output. A
    // caller that wants to store this as related tables (a messages table and an
    // attachments table joined to it) therefore needs the rows at each grain,
    // not just the final flattened set. A merging step widens the CURRENT grain;
    // an expanding step — or one the author asked to keep in its own table —
    // opens a new one.
    const grains = trace ? [{ level: 0, tool, rows }] : null;
    // rows[i] → its index in grains[last].rows. Null means identity, which is
    // exactly true at grain 0 (they are the same array).
    let rowGrainIndex = null;

    const budget = { remaining: MAX_CHAIN_CALLS };
    for (const step of chain) {
        if (!isPlainObject(step)) continue;
        if (!rows.length) break;
        const stepResult = await applyChainStep(step, rows, budget, exec, deps, app, connector, {
            trace,
            grainRows: grains ? grains[grains.length - 1].rows : null,
            rowGrainIndex,
        });
        rows = trace ? stepResult.rows : stepResult;
        if (!grains) continue;

        // The step's own fields about the SOURCE always widen the current grain
        // (gmail_read's body belongs on the message, not on each attachment) —
        // unless the step keeps its result in a table of its own, in which case
        // parentRows comes back untouched.
        grains[grains.length - 1].rows = stepResult.parentRows || rows;
        rowGrainIndex = stepResult.grainIndexOf || null;
        if ((step.expand || step.ownTable === true) && stepResult.childRows) {
            grains.push({
                level: grains.length,
                tool: step.tool,
                expandFrom: step.expand || null,
                parentLevel: grains.length - 1,
                rows: stepResult.childRows,
            });
        }
    }
    // Say it out loud when the budget cut the enrichment short — a silently
    // half-enriched table is the kind of thing nobody notices until it matters.
    const partial = rows.some((r) => isPlainObject(r) && r._partial);
    return { rows, ...(partial ? { partial: true } : {}), ...(grains ? { grains } : {}) };
}

async function runAutomationConnector(connector, { app, viewerId, params, deps }) {
    const automationId = typeof connector.automationId === 'string' ? connector.automationId : '';
    if (!automationId) throw connectorError(400, 'connector has no automationId', 'bad_connector');

    const automation = await deps.getAutomation(automationId);
    if (!automation) throw connectorError(404, 'Automation not found', 'not_found');
    // Owner-ownership check — a routine transferred away after wiring must not
    // run acts-as-owner as someone else's (mirrors studioAppsRun.js).
    if (automation.userId !== app.userId) {
        throw connectorError(403, 'Automation does not belong to the app owner', 'forbidden');
    }

    const run = await deps.executeAutomation(automation, {
        triggerKind: 'studio_app',
        triggerPayload: {
            params: sanitizeViewerParams(params),
            _viewerUserId: viewerId || null,
            _studioAppId: app.id,
        },
        mode: 'live',
    });
    if (run && run.status && run.status !== 'success') {
        return { rows: [] };
    }
    // The persisted run row carries no `output` column, so read the routine's
    // final value through the SAME derivation the action bridge uses
    // (actionExecutor.deriveFinalOutput → last executed top-level step).
    return { rows: toRows(await deps.deriveFinalOutput(run)) };
}

/**
 * Read an upstream body with MAX_REST_BYTES enforced WHILE streaming: a hostile
 * upstream must never be buffered whole first. Exceeding the cap aborts the
 * in-flight request (`ac`) so the socket is torn down instead of drained.
 * Responses without a web stream (stubs, older shims) fall back to a buffered
 * read that is still byte-capped.
 */
async function readCappedBody(resp, ac) {
    const body = resp.body;
    if (!body || typeof body.getReader !== 'function') {
        const text = await resp.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_REST_BYTES) {
            throw connectorError(502, 'connector response too large', 'connector_failed');
        }
        return text;
    }
    const reader = body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            bytes += chunk.length;
            if (bytes > MAX_REST_BYTES) {
                ac.abort();
                throw connectorError(502, 'connector response too large', 'connector_failed');
            }
            chunks.push(chunk);
        }
    } finally {
        try { await reader.cancel(); } catch { /* already closed/aborted */ }
    }
    return Buffer.concat(chunks).toString('utf8');
}

// Static host of a URL template, with placeholders neutralised so a template
// query param can't be misread as part of the authority.
function templateHost(template) {
    try {
        const probe = String(template).replace(/\{[a-zA-Z0-9_]+\}/g, '0');
        return new URL(probe).host.toLowerCase();
    } catch { return null; }
}

async function runRestConnector(connector, { app, params, deps }) {
    const template = typeof connector.url === 'string' ? connector.url : '';
    if (!template) throw connectorError(400, 'connector has no url template', 'bad_connector');

    // The host must be fixed by the owner — a viewer must never be able to steer
    // it. Reject a template that tries to template its own authority.
    const host = templateHost(template);
    if (!host) throw connectorError(400, 'connector url template is invalid', 'bad_connector');
    const authorityPart = template.split(/[/?#]/).slice(0, 3).join('/'); // scheme://host[:port]
    if (/\{[a-zA-Z0-9_]+\}/.test(authorityPart)) {
        throw connectorError(400, 'connector url may not template the host', 'bad_connector');
    }

    // Fill declared placeholders with URL-encoded viewer params only.
    const placeholders = [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
    const safe = sanitizeViewerParams(params, placeholders);
    const urlStr = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
        const v = safe[key];
        return (v === undefined || v === null) ? '' : encodeURIComponent(String(v));
    });

    let parsed;
    try { parsed = new URL(urlStr); } catch { throw connectorError(400, 'connector produced an invalid URL', 'bad_connector'); }
    if (parsed.protocol !== 'https:') throw connectorError(400, 'connector URL must be https', 'insecure_url');
    // Encoding above prevents authority injection; this equality check is
    // belt-and-braces against it.
    if (parsed.host.toLowerCase() !== host) throw connectorError(403, 'connector URL host is not allow-listed', 'forbidden_host');
    // SSRF: refuse private/internal/metadata targets (sync, DNS-less pre-filter).
    if (deps.isPrivateTarget(parsed.toString())) {
        throw connectorError(403, 'connector target refused (private/internal address)', 'forbidden_host');
    }

    // Owner static headers + owner credential (from the credential store).
    const headers = { Accept: 'application/json' };
    if (isPlainObject(connector.headers)) {
        for (const [k, v] of Object.entries(connector.headers)) {
            if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) headers[k] = String(v);
        }
    }
    if (isPlainObject(connector.auth) && connector.auth.credentialProvider) {
        const cred = await deps.getProviderAuth(app.userId, connector.auth.credentialProvider).catch(() => null);
        const token = cred?.accessToken || null;
        if (token) {
            if (connector.auth.type === 'header' && typeof connector.auth.header === 'string') headers[connector.auth.header] = token;
            else headers.Authorization = `Bearer ${token}`;
        }
    }

    // safeFetch re-screens every socket connect (DNS-rebind + redirect hops).
    // The timer spans the BODY READ too — a slow drip must not outlive the
    // timeout just because the headers arrived in time.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REST_TIMEOUT_MS);
    let text;
    try {
        const resp = await deps.safeFetch(parsed.toString(), { method: 'GET', headers, redirect: 'follow', signal: ac.signal });
        if (!resp || !resp.ok) {
            throw connectorError(502, `connector fetch failed (${resp ? resp.status : 'no response'})`, 'connector_failed');
        }
        text = await readCappedBody(resp, ac);
    } catch (err) {
        if (Number.isInteger(err?.status)) throw err;
        throw connectorError(502, `connector fetch failed (${err?.name === 'AbortError' ? 'timeout' : 'unreachable'})`, 'connector_failed');
    } finally {
        clearTimeout(timer);
    }

    let json;
    try { json = JSON.parse(text); } catch { throw connectorError(502, 'connector response was not JSON', 'connector_failed'); }

    const cap = Math.min(
        Number.isFinite(connector.maxRows) && connector.maxRows > 0 ? connector.maxRows : MAX_CONNECTOR_ROWS,
        MAX_CONNECTOR_ROWS,
    );
    const rows = toRows(getByPath(json, connector.rowsPath), cap);
    const nextPage = connector.nextPagePath ? getByPath(json, connector.nextPagePath) : null;
    return { rows, ...(nextPage != null && nextPage !== '' ? { nextPage } : {}) };
}

/**
 * Run a connector ACTS-AS-OWNER and return a bounded { rows, nextPage? }.
 *
 * @param {object} connector  A connector object from model.connectors (NOT the
 *                            public projection — carries fixedArgs/url/auth).
 * @param {object} opts
 * @param {object} opts.app      The studio app { id, userId, organizationId }.
 * @param {string} opts.viewerId The calling viewer's id (audit only).
 * @param {object} opts.params   Viewer-supplied params (sanitised in here).
 * @param {object} [opts.systemArgs] SERVER-ORIGIN args (the sync's since-param).
 *                            Never settable from an HTTP request body; ranked
 *                            above viewer params but below author fixedArgs.
 * @param {object} [opts._deps]  Test-only dependency overrides.
 */
async function runConnector(connector, { app, viewerId, params, systemArgs, trace = false, _deps } = {}) {
    if (!isValidConnector(connector)) throw connectorError(400, 'invalid connector', 'bad_connector');
    if (!app || typeof app.userId !== 'string') throw connectorError(400, 'connector run requires an owned app', 'bad_app');
    const deps = { ...defaultDeps(), ...(_deps || {}) };
    const ctx = { app, viewerId, params, systemArgs, trace, deps };

    switch (connector.kind) {
        case 'integration_tool': return runIntegrationTool(connector, ctx);
        case 'automation':       return runAutomationConnector(connector, ctx);
        case 'rest':             return runRestConnector(connector, ctx);
        // Lazily required: mailboxConnector depends back on this module for the
        // shared session builder, so a top-level require would be circular.
        case 'mailbox':          return require('./mailboxConnector').runMailboxConnector(connector, ctx);
        default:                 throw connectorError(400, `unknown connector kind "${connector.kind}"`, 'bad_connector');
    }
}

module.exports = {
    CONNECTOR_KINDS,
    listConnectors,
    findConnector,
    runConnector,
    filterDeclaredParams,
    // Exported for tests / sibling wiring.
    _declaredParamKeys: declaredParamKeys,
    _sanitizeViewerParams: sanitizeViewerParams,
    _toRows: toRows,
    _getByPath: getByPath,
    _publicConnector: publicConnector,
    _readRowPath: readRowPath,
    _applyChainStep: applyChainStep,
    _unwrapListEnvelope: unwrapListEnvelope,
    _MAX_CONNECTOR_ROWS: MAX_CONNECTOR_ROWS,
    _MAX_CHAIN_STEPS: MAX_CHAIN_STEPS,
    _MAX_CHAIN_CALLS: MAX_CHAIN_CALLS,
    // Shared with appStudio/mailboxIdentity.js so a mailbox resolves its viewer
    // through the exact same session shim as every other connector.
    _defaultBuildUserSession: defaultBuildUserSession,
    _connectorError: connectorError,
};
