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
 *   • automation       — trigger one of the owner's automations
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
// The connector runtime is split under ./connectors/: shared helpers, the
// sessions and default deps, single-tool dispatch, chains, and the kind
// runners. This module keeps runConnector and the public surface.
const {
    CONNECTOR_KINDS, MAX_CONNECTOR_ROWS, MAX_CHAIN_STEPS, MAX_CHAIN_CALLS,
    connectorError, isValidConnector, publicConnector, listConnectors, findConnector,
    sanitizeViewerParams, declaredParamKeys, filterDeclaredParams, unwrapListEnvelope, toRows, getByPath,
} = require('./connectors/shared');
const { defaultBuildUserSession, defaultDeps } = require('./connectors/session');
const { readRowPath } = require('./connectors/dispatch');
const { applyChainStep } = require('./connectors/chain');
const { runIntegrationTool, runAutomationConnector, runRestConnector } = require('./connectors/runners');

/**
 * Run a connector ACTS-AS-OWNER and return a bounded { rows, nextPage? }.
 *
 * `opts`: `app` is the studio app, `viewerId` the calling viewer's id (audit
 * only), `params` the viewer-supplied params (sanitised in here), `systemArgs`
 * the SERVER-ORIGIN args (the sync's since-param: never settable from an HTTP
 * request body; ranked above viewer params but below author fixedArgs),
 * `_deps` test-only dependency overrides.
 *
 * @param {import('./connectors/shared').Connector} connector  A connector object from model.connectors
 *   (NOT the public projection — carries fixedArgs/url/auth).
 * @param {{ app: import('./connectors/shared').ConnectorApp, viewerId?: string, params?: unknown, systemArgs?: unknown,
 *   trace?: boolean, _deps?: Partial<import('./connectors/session').ConnectorDeps> }} [opts]
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
