/**
 * Shared egress logger — the ONE write path for integration activity rows.
 *
 * Replaces three near-duplicate inline blocks (agent chatStream, direct-chat
 * toolExec, automation safety.logEgress) that had drifted apart in every
 * dimension that matters:
 *   - chat paths wrote a row only when `monitorIntegrations` was on, the
 *     automation path always did — so the "GDPR audit ledger" was complete or
 *     not depending on which surface made the call;
 *   - failed tool calls logged on one path and not the other, and never with
 *     a status;
 *   - chat paths passed NO ctx to resolveIntegration, so Nextcloud/YouTrack/
 *     n8n rows had a NULL endpoint;
 *   - each path had its own PII-category vocabulary and separator.
 *
 * The rule now (owner decision, 2026-08-01):
 *   The minimal metadata row is ALWAYS written — host, country, operator,
 *   status, duration. No content. It is the evidence base for Art 44 /
 *   Art 26(6) / RoPA, and a toggle must not blind the compliance record.
 *   `monitorIntegrations` gates CONTENT SCANNING only:
 *     off               → pii_scan_level 'none'  (payload never even scanned)
 *     on                → 'basic'  (in-process regex sniff)
 *     on + GLiNER ran   → 'full'
 *
 * Everything slow (shield lookup, ctx resolution, scanning, the insert) runs
 * DETACHED — the caller's await resolves in microseconds. Pending work is
 * tracked so tests and shutdown can `flushEgressLogs()`.
 */

const { encodeCategories } = require('../privacy/piiCategories');
const log = require('../../telemetry/log');

// Stores, lazily required (each one opens the DB pool when loaded). Tests
// swap them through __setDepsForTests instead of reaching into the module cache.
const DEFAULT_DEPS = {
    activityStore: () => require('../../stores/integrationActivityStore'),
    configStore: () => require('../../stores/configStore'),
    customIntegrationStore: () => require('../../stores/orgCustomIntegrationStore'),
    userStore: () => require('../../stores/userStore'),
};
let _deps = { ...DEFAULT_DEPS };

const PAYLOAD_SCAN_CAP = 16 * 1024;  // chars of args+result considered for scanning
const GLINER_SCAN_CAP = 5000;        // default single-call GLiNER slice (callers may scan wider)

// ── Detached-work tracking ─────────────────────────────────────────────
const _pending = new Set();
function _track(promise) {
    _pending.add(promise);
    promise.catch(() => {}).finally(() => _pending.delete(promise));
    return promise;
}

/** Await every in-flight egress row (tests, graceful shutdown). */
async function flushEgressLogs() {
    await Promise.allSettled([..._pending]);
}

// ── Integration ctx (endpoint resolution for the serverFns) ────────────
// Small TTL cache: one (org,user) pair costs at most two config reads per
// 5 minutes instead of two per tool call.
const _ctxCache = new Map(); // key → { ctx, at }
const CTX_TTL_MS = 5 * 60 * 1000;

// A custom integration's host lives in its stored definition, so the ledger
// looks it up (cached per slug) and hands it to resolveIntegration as ctx.
const _cintCache = new Map(); // slug → { value, at }

async function _resolveCustomIntegration(toolName) {
    const slug = String(toolName).slice('cint_'.length).split('_')[0];
    if (!slug) return null;
    const hit = _cintCache.get(slug);
    if (hit && Date.now() - hit.at < CTX_TTL_MS) return hit.value;
    let value = null;
    try {
        const integration = await _deps.customIntegrationStore().getBySlug(slug);
        if (integration) {
            const def = integration.activatedDefinition || integration.definition || {};
            const baseUrl = integration.kind === 'mcp_remote'
                ? (def.mcp && def.mcp.url) || null
                : (def.api && def.api.baseUrl) || null;
            value = { name: integration.name || slug, baseUrl: typeof baseUrl === 'string' ? baseUrl : null };
        }
    } catch (_) { value = null; }
    _cintCache.set(slug, { value, at: Date.now() });
    if (_cintCache.size > 500) _cintCache.delete(_cintCache.keys().next().value);
    return value;
}

// Rows are read per organization. A caller that only knows the user (a
// trigger poll) still lands in its org's ledger.
const _orgCache = new Map(); // userId → { orgId, at }

async function _orgForUser(userId) {
    const hit = _orgCache.get(userId);
    if (hit && Date.now() - hit.at < CTX_TTL_MS) return hit.orgId;
    let orgId = null;
    try { orgId = (await _deps.userStore().getUser(userId))?.organizationId || null; } catch (_) { orgId = null; }
    _orgCache.set(userId, { orgId, at: Date.now() });
    if (_orgCache.size > 500) _orgCache.delete(_orgCache.keys().next().value);
    return orgId;
}

async function _resolveIntegrationCtx({ userId, orgId, session, toolName = null }) {
    const ctx = {
        // Session carries the Nextcloud base URL when the NC connector is active.
        nextcloudUrl: session?.connectorNcBaseUrl || session?.nextcloudUrl || null,
        youtrackUrl: null,
        n8nUrl: null,
    };
    // Only for cint_ tools, and only here: resolveIntegration answers null
    // for them to every other caller (lending, the tool-PII class, step
    // contracts), so the ledger fix changes nothing about those.
    const custom = typeof toolName === 'string' && toolName.startsWith('cint_')
        ? { customIntegration: await _resolveCustomIntegration(toolName) }
        : {};
    const key = `${orgId || ''}:${userId || ''}`;
    const hit = _ctxCache.get(key);
    if (hit && Date.now() - hit.at < CTX_TTL_MS) {
        return { ...hit.ctx, nextcloudUrl: ctx.nextcloudUrl || hit.ctx.nextcloudUrl, ...custom };
    }
    try {
        const configStore = _deps.configStore();
        if (orgId) ctx.n8nUrl = (await configStore.getConfig(`n8n_url_org_${orgId}`)) || null;
        if (userId && typeof configStore.getSecret === 'function') {
            ctx.youtrackUrl = (await configStore.getSecret(`youtrack_url_user_${userId}`)) || null;
        }
    } catch (_) { /* endpoint resolution is best-effort */ }
    _ctxCache.set(key, { ctx, at: Date.now() });
    if (_ctxCache.size > 500) _ctxCache.delete(_ctxCache.keys().next().value);
    return { ...ctx, ...custom };
}

/**
 * The name of the MCP server behind an mcp_ tool, for its child-process peer.
 * `mcp__<server>__<tool>` names it exactly; `mcp_<server>_<tool>` only up to
 * the first underscore, which is what the ledger label has always used.
 */
function _mcpServerName(toolName, meta) {
    if (toolName.startsWith('mcp__')) return toolName.split('__')[1] || 'mcp';
    if (meta && meta.integration && meta.integration !== 'mcp') return meta.integration;
    return toolName.replace(/^mcp_/, '').split('_')[0] || 'mcp';
}

/**
 * The probe as the ledger stores it. Two additions to what the capture saw:
 *   - an MCP tool whose call reached no socket of ours ran in a stdio child
 *     process; its traffic is that process's, so the row gets one peer that
 *     says so (host = the server name, no address, basis 'child_process');
 *   - the legacy `is_local` flag is set on a copy for local integrations, as
 *     it always was, for the store that still reads it.
 */
function _probeForRow(probe, toolName, meta, blocked) {
    let out = probe || null;
    const hasSocketPeer = !!(out && Array.isArray(out.peers) && out.peers.length);
    if (!blocked && !hasSocketPeer && typeof toolName === 'string' && toolName.startsWith('mcp_')) {
        const { withPeers } = require('../http/egressCapture');
        out = withPeers(out, [{ host: _mcpServerName(toolName, meta), ip: null, basis: 'child_process', sentBody: true }]);
    }
    if (out && meta.isLocal && !out.is_local) out = { ...out, is_local: true };
    return out;
}

function _stringifyPayload(toolArgs, result) {
    const s = (v) => {
        if (v === undefined || v === null) return '';
        if (typeof v === 'string') return v;
        try { return JSON.stringify(v); } catch (_) { return String(v); }
    };
    return `${s(toolArgs)}\n${s(result)}`.slice(0, PAYLOAD_SCAN_CAP);
}

/**
 * Log one outbound tool call. Returns immediately; all I/O is detached.
 *
 * @param {object} o
 * @param {string}  o.toolName
 * @param {object}  [o.toolArgs]
 * @param {*}       [o.result]        Tool result (scanned when monitoring is on).
 * @param {Error|string} [o.error]    Marks the row status 'error'.
 * @param {boolean} [o.blocked]       Marks the row status 'blocked' (guardrail refusal).
 * @param {object}  [o.probe]         outboundProbe snapshot: `peers` plus the legacy
 *                                    single-destination fields (see outboundProbe.js).
 * @param {string}  o.source          'agent_stream' | 'direct_chat' | 'routine'.
 * @param {string}  [o.model]
 * @param {number}  [o.durationMs]    Wall-clock around the tool dispatch.
 * @param {object}  o.ids             organization_id, user_id, agent_id, agent_name,
 *                                    conversation_id, automation_id, run_id, step_id,
 *                                    acting_user_id, connection_id, grant_id.
 * @param {boolean} [o.isDryRun]
 * @param {boolean} [o.servedFromCache] The answer was replayed from the durable
 *                                    response cache — the row is kept (the org
 *                                    does use this processor) but flagged, so
 *                                    the Art-44 transfer count can exclude it.
 * @param {object}  [o.shield]        Pre-resolved shield/policy. When ABSENT the
 *                                    org's shield config is fetched (chat paths).
 *                                    Shape: { monitorIntegrations, piiDetectionConfidenceThreshold }.
 * @param {object}  [o.session]       Express session (Nextcloud base URL).
 * @param {Function}[o.fullScan]      async (text, threshold) → {hasPii, entities}|null.
 *                                    Overrides the default single-call GLiNER scan
 *                                    (chatStream reuses its pre-scan; automations
 *                                    scan in windows).
 * @param {object}  [o.preResolvedMeta] resolveIntegration output, when the caller
 *                                    already has one WITH ctx applied.
 */
function logToolEgress(o) {
    // Stringify synchronously: callers mutate tool results after this call
    // (kb dedup and friends), and an audit row must reflect what the call saw.
    let payloadText = null;
    try { payloadText = _stringifyPayload(o.toolArgs, o.result); } catch (_) { payloadText = ''; }

    _track((async () => {
        try {
            const ids = o.ids || {};
            const organizationId = ids.organization_id
                || (ids.user_id ? await _orgForUser(ids.user_id) : null);

            // Shield: passed by the automation path, fetched for the chat paths.
            let shield = o.shield;
            if (shield === undefined && organizationId) {
                try {
                    const configStore = _deps.configStore();
                    shield = await configStore.getConfig(`org_privacy_shield_${organizationId}`);
                } catch (_) { shield = null; }
            }

            // Resolve the integration WITH ctx — this is what fills
            // server_endpoint for Nextcloud/YouTrack/n8n on the chat paths.
            let meta = o.preResolvedMeta;
            if (!meta) {
                const { resolveIntegration } = require('./integrationToolMap');
                const ctx = await _resolveIntegrationCtx({
                    userId: ids.user_id, orgId: organizationId, session: o.session || null,
                    toolName: o.toolName,
                });
                meta = resolveIntegration(o.toolName, o.toolArgs || {}, ctx);
            }
            if (!meta) return; // internal tool — nothing left the platform

            // Content scanning — gated by the org toggle; the row is not.
            const monitor = shield?.monitorIntegrations === true;
            let scanLevel = 'none';
            const categories = [];
            if (monitor && payloadText) {
                scanLevel = 'basic';
                try {
                    const { scanOutputForPii } = require('./integrationToolMap');
                    const quick = scanOutputForPii(payloadText);
                    if (quick) categories.push(...quick.split(','));
                } catch (_) { /* sniff is best-effort */ }
                try {
                    const threshold = typeof shield?.piiDetectionConfidenceThreshold === 'number'
                        ? shield.piiDetectionConfidenceThreshold : 0.7;
                    let piiResult = null;
                    if (typeof o.fullScan === 'function') {
                        piiResult = await o.fullScan(payloadText, threshold);
                    } else {
                        const { detectPii } = require('../privacy/piiDetection');
                        piiResult = await detectPii(payloadText.slice(0, GLINER_SCAN_CAP), null, threshold);
                    }
                    if (piiResult) {
                        scanLevel = 'full';
                        for (const e of (piiResult.entities || [])) {
                            // e.category is the canonical id; e.label the human label.
                            categories.push(e.category || e.label);
                        }
                    }
                } catch (_) { /* GLiNER unavailable → stay at 'basic' */ }
            }

            const probe = _probeForRow(o.probe, o.toolName, meta, !!o.blocked);

            const store = _deps.activityStore();
            await store.logIntegrationActivity({
                organization_id: organizationId || null,
                user_id: ids.user_id || null,
                agent_id: ids.agent_id || null,
                agent_name: ids.agent_name || null,
                conversation_id: ids.conversation_id || null,
                tool_name: o.toolName,
                integration_type: meta.integration,
                server_endpoint: meta.server,
                data_direction: meta.direction,
                data_categories: meta.dataCategories,
                pii_categories_detected: encodeCategories(categories),
                pii_scan_level: scanLevel,
                source: o.source || 'unknown',
                model: o.model || null,
                probe,
                // The integration's own "this stays on the box" flag, on every
                // row with or without a probe. The store uses it only when no
                // connection was seen; a peer always outranks it.
                is_local_hint: !!meta.isLocal,
                // A shield refusal arrives WITH the error it threw; it is
                // still a block, not a failed call.
                status: o.blocked ? 'blocked' : (o.error ? 'error' : 'success'),
                error_message: o.error ? (o.error.message || String(o.error)) : null,
                duration_ms: o.durationMs,
                automation_id: ids.automation_id || null,
                run_id: ids.run_id || null,
                step_id: ids.step_id || null,
                is_dry_run: !!o.isDryRun,
                // The answer was replayed from the durable response cache, so
                // no bytes crossed the boundary on this call. The row still
                // exists — it is the only evidence the org uses this processor
                // at all — but the Art-44 transfer count must not count it.
                served_from_cache: !!o.servedFromCache,
                acting_user_id: ids.acting_user_id || null,
                connection_id: ids.connection_id || null,
                grant_id: ids.grant_id || null,
            });
        } catch (e) {
            log.error('[IntegrationLogging] egress row failed:', e.message);
        }
    })());
}

/** Test hook. */
function __resetCtxCacheForTests() { _ctxCache.clear(); _cintCache.clear(); _orgCache.clear(); }

/** Test hook: replace store factories ({ activityStore: () => stub, … }); no argument restores. */
function __setDepsForTests(over = null) {
    _deps = { ...DEFAULT_DEPS, ...(over || {}) };
    __resetCtxCacheForTests();
}

module.exports = { logToolEgress, flushEgressLogs, __resetCtxCacheForTests, __setDepsForTests };
