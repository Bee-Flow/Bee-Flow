// @typecheck strict
/**
 * Custom Integration Runner — steps of executeCustomIntegrationTool
 * (customIntegrationRunner.js) and the pure helpers they share with it: the
 * remote-MCP delegation, credential resolution, request headers, and
 * shaping the vendor's answer, plus truncation and secret scrubbing.
 *
 * A step that refuses returns `{ refusal }`: the message the runner turns into
 * its `{ error }` result through the same secret scrub as every other refusal.
 */

'use strict';

const EXACT_PLACEHOLDER_RE = /^\{([A-Za-z0-9_]+)\}$/;
const DEFAULT_MAX_RESPONSE_CHARS = 30000;
const REDACTED = '[redacted:credential]';

// Mirrors validateCustomIntegration's denylist (kept in sync by hand — the
// validator is not imported so requiring the runner stays dependency-light).
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const DENIED_HEADERS = new Set([
    'host', 'authorization', 'cookie', 'set-cookie', 'content-length',
    'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
]);
const DENIED_HEADER_PREFIXES = ['proxy-', 'x-forwarded-'];

/**
 * @typedef {import('./customIntegrationRunner').CustomIntegrationRow} CustomIntegrationRow
 * @typedef {import('./customIntegrationRunner').CustomIntegrationDefinition} CustomIntegrationDefinition
 * @typedef {import('./customIntegrationRunner').RestTool} RestTool
 * @typedef {{ id: string, provider?: string, status?: string, orgId?: string | null,
 *   secretMeta?: { boundOrigin?: string } | null, secret?: unknown }} RunConnection  a connection with its decrypted secret
 * @typedef {{
 *   getConnectionWithSecret(id: string): Promise<RunConnection | null>,
 *   resolveConnectionForRun(q: { runningUserId: string, runningUserOrgId: string, runningUserGroups: string[],
 *     ownerUserId: string, provider: string }): Promise<{ available?: boolean, connectionId?: string | null }>,
 *   resolveOrgId(orgId: unknown): string,
 * }} ConnectionStore  what the run needs of stores/integrationConnectionStore
 * @typedef {{ refusal: string }} Refusal
 */

/**
 * Hard-truncate a string to `max` chars. Returns { text, truncated }.
 * @param {unknown} text
 * @param {number} [max]
 */
function truncateBudget(text, max) {
    const s = typeof text === 'string' ? text : String(text ?? '');
    const cap = Number.isInteger(max) && /** @type {number} */ (max) > 0 ? /** @type {number} */ (max) : DEFAULT_MAX_RESPONSE_CHARS;
    if (s.length <= cap) return { text: s, truncated: false };
    return { text: s.slice(0, cap), truncated: true };
}

/**
 * Replace every literal secret value (length >= 6), its base64/base64url
 * encodings and its encodeURIComponent form with a redaction marker. Longest
 * forms first so partial overlaps cannot leave fragments behind. Canonical
 * implementation — customMcpClient delegates here. Anything but a non-empty
 * string comes back as it was.
 * @template T
 * @param {T} text
 * @param {unknown} values
 * @returns {T | string}
 */
function scrubSecrets(text, values) {
    if (typeof text !== 'string' || !text) return text;
    /** @type {Set<string>} */
    const forms = new Set();
    for (const v of Array.isArray(values) ? values : []) {
        if (typeof v !== 'string' || v.length < 6) continue;
        forms.add(v);
        forms.add(Buffer.from(v, 'utf8').toString('base64'));
        forms.add(Buffer.from(v, 'utf8').toString('base64url'));
        forms.add(encodeURIComponent(v));
    }
    /** @type {string} */
    let out = text;
    for (const f of [...forms].sort((a, b) => b.length - a.length)) {
        if (f.length >= 6 && out.includes(f)) out = out.split(f).join(REDACTED);
    }
    return out;
}

/**
 * @param {unknown} obj
 * @param {unknown} path  dot-separated
 * @returns {unknown}
 */
function getByDotPath(obj, path) {
    let cur = obj;
    for (const seg of String(path).split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = /** @type {Record<string, unknown>} */ (cur)[seg];
        if (cur === undefined) return undefined;
    }
    return cur;
}

/**
 * mcp_remote → delegate, then apply the same scrub/truncate. Vendor MCP tool
 * names may contain characters illegal in cint_ names (dashes, uppercase).
 * Activation stores the original under _cint.rawName on each tools_cache
 * entry, so the prefixed name is mapped back through the cache before
 * delegating. No cache entry ⇒ the tool is not part of this integration's
 * frozen tool set.
 * @param {CustomIntegrationRow} integration
 * @param {{ prefixedName: string, toolName: string, args: Record<string, unknown>, userId: string, secretValues: string[] }} call
 * @returns {Promise<Refusal | { result: unknown, truncated?: boolean }>}
 */
async function callRemoteMcpTool(integration, { prefixedName, toolName, args, userId, secretValues }) {
    let client;
    try {
        client = require('../core/customIntegrations/customMcpClient');
    } catch (_) {
        return { refusal: 'Remote MCP integrations are not available yet.' };
    }
    const cacheEntry = (Array.isArray(integration.toolsCache) ? integration.toolsCache : [])
        .find((/** @type {{ function?: { name?: string }, _cint?: { rawName?: string } }} */ e) => e?.function?.name === prefixedName);
    if (!cacheEntry) {
        return { refusal: `Tool "${toolName}" is not part of this integration. Re-activate the integration to refresh its tools.` };
    }
    const remoteName = cacheEntry._cint?.rawName || toolName;
    const res = await client.callTool(integration, remoteName, args || {}, userId);
    if (res && typeof res === 'object' && typeof res.error === 'string') {
        return { refusal: truncateBudget(res.error, DEFAULT_MAX_RESPONSE_CHARS).text };
    }
    const serialized = typeof res === 'string' ? res : JSON.stringify(res ?? null);
    const { text, truncated } = truncateBudget(serialized, DEFAULT_MAX_RESPONSE_CHARS);
    /** @type {{ result: unknown, truncated?: boolean }} */
    const out = { result: scrubSecrets(text, secretValues) };
    if (truncated) out.truncated = true;
    return out;
}

/**
 * Credential resolution (provider 'custom:<integrationId>'): the connection
 * the test route named, else the one the run resolves to. Hard asserts: same
 * org, and the credential pinned to this exact API origin (set when the
 * credential was entered).
 * @param {ConnectionStore} connStore
 * @param {{ integration: CustomIntegrationRow, connectionOverrideId: string | null, userId: string, userOrg: string,
 *   integrationOrg: string, baseOrigin: string }} run
 */
async function resolveRunCredentials(connStore, { integration, connectionOverrideId, userId, userOrg, integrationOrg, baseOrigin }) {
    const provider = `custom:${integration.id}`;
    let connection;
    if (connectionOverrideId) {
        connection = await connStore.getConnectionWithSecret(connectionOverrideId);
        if (!connection || connection.provider !== provider) {
            return { refusal: 'The selected connection does not belong to this integration.' };
        }
    } else {
        const resolution = await connStore.resolveConnectionForRun({
            runningUserId: userId,
            runningUserOrgId: userOrg,
            runningUserGroups: [],
            ownerUserId: userId,
            provider,
        });
        if (!resolution.available || !resolution.connectionId) {
            return { refusal: 'No credentials connected for this integration. Add them under Settings → Connections.' };
        }
        connection = await connStore.getConnectionWithSecret(resolution.connectionId);
    }
    return checkRunConnection(connStore, connection, integrationOrg, baseOrigin);
}

/**
 * The resolved connection's secret, or why it cannot be used: inactive or
 * missing, another org's, bound to another API host, or unreadable.
 * @param {ConnectionStore} connStore
 * @param {RunConnection | null} connection
 * @param {string} integrationOrg
 * @param {string} baseOrigin
 */
function checkRunConnection(connStore, connection, integrationOrg, baseOrigin) {
    if (!connection || connection.status !== 'active') {
        return { refusal: 'The stored credentials are unavailable — re-enter credentials for this integration.' };
    }
    if (connStore.resolveOrgId(connection.orgId) !== integrationOrg) {
        return { refusal: 'The stored credentials belong to a different organization.' };
    }
    if (!connection.secretMeta || connection.secretMeta.boundOrigin !== baseOrigin) {
        return { refusal: 'The stored credential is bound to a different API host — re-enter credentials for this integration.' };
    }
    const secret = connection.secret;
    if (!secret || typeof secret !== 'object') {
        return { refusal: 'The stored credentials could not be read — re-enter credentials for this integration.' };
    }
    return { connection, secret };
}

/**
 * The request headers: the definition's literals, then the tool's. Defense in
 * depth: the validator's header denylist is applied again here — the runner
 * owns transport/auth/proxy headers even if a definition somehow reached
 * storage without passing validation. Body and auth are added by the caller.
 * @param {CustomIntegrationDefinition} def
 * @param {RestTool} tool
 * @returns {Record<string, string>}
 */
function requestHeaders(def, tool) {
    /** @type {Record<string, string>} */
    const headers = {};
    /** @param {unknown} map */
    const applyHeaders = (map) => {
        if (!map || typeof map !== 'object' || Array.isArray(map)) return;
        for (const [k, v] of Object.entries(map)) {
            if (typeof v !== 'string' || !HEADER_NAME_RE.test(k)) continue;
            const n = k.toLowerCase();
            if (DENIED_HEADERS.has(n) || DENIED_HEADER_PREFIXES.some(p => n.startsWith(p))) continue;
            headers[k] = v;
        }
    };
    applyHeaders(def.api?.defaultHeaders);
    applyHeaders(tool.headers);
    return headers;
}

/**
 * The tool result of a successful answer, budgeted and scrubbed: JSON (cut to
 * resultPath when it resolves; a missing path keeps the whole body), text, or
 * for anything else metadata only — never raw bytes into the context.
 * @param {{ status: number, headers: { get(name: string): string | null } }} response
 * @param {Buffer} raw  the capped body
 * @param {RestTool} tool
 * @param {number} maxChars
 * @param {string[]} secretValues
 * @returns {Refusal | { status: number, result?: unknown, truncated?: boolean, message?: string, contentType?: string, bytes?: number }}
 */
function shapeResponse(response, raw, tool, maxChars, secretValues) {
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('json')) { // application/json + */*+json variants
        let parsedBody;
        try {
            parsedBody = JSON.parse(raw.toString('utf8'));
        } catch {
            return { refusal: 'The API returned invalid JSON.' };
        }
        let extracted = parsedBody;
        if (typeof tool.resultPath === 'string' && tool.resultPath) {
            const v = getByDotPath(parsedBody, tool.resultPath);
            if (v !== undefined) extracted = v;
        }
        const { text, truncated } = truncateBudget(JSON.stringify(extracted) ?? 'null', maxChars);
        /** @type {{ status: number, result: unknown, truncated?: boolean, message?: string }} */
        const out = { status: response.status, result: scrubSecrets(text, secretValues) };
        if (truncated) {
            out.truncated = true;
            out.message = `Response truncated to ${maxChars} characters. Narrow the request (filters, pagination) for complete data.`;
        }
        return out;
    }
    if (contentType.startsWith('text/')) {
        const { text, truncated } = truncateBudget(raw.toString('utf8'), maxChars);
        /** @type {{ status: number, result: unknown, truncated?: boolean }} */
        const out = { status: response.status, result: scrubSecrets(text, secretValues) };
        if (truncated) out.truncated = true;
        return out;
    }
    return { status: response.status, contentType: contentType || 'unknown', bytes: raw.length };
}

module.exports = {
    EXACT_PLACEHOLDER_RE, DEFAULT_MAX_RESPONSE_CHARS,
    truncateBudget, scrubSecrets, getByDotPath,
    callRemoteMcpTool, resolveRunCredentials, requestHeaders, shapeResponse,
};
