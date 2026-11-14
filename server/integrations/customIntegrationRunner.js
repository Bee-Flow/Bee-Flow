// @typecheck
/**
 * Custom Integration Runner — hardened generic executor for org-scoped
 * custom integrations (AI Integration Builder).
 *
 * Executes 'rest' definitions (specVersion 1) declaratively: every request is
 * pinned to the activated definition's api.baseUrl origin, SSRF-checked via
 * ssrfGuard (DNS-validated + pinned dispatcher), and credentials are injected
 * exclusively through auth.valueTemplate at the last moment. 'mcp_remote'
 * integrations are delegated to customMcpClient.
 *
 * Tool names: cint_<slug>_<toolName> where slug matches ^[a-z0-9]{4,16}$
 * (no underscores — parsing is unambiguous at the first '_' after 'cint_').
 *
 * Fail-closed everywhere: any check that cannot be positively confirmed
 * refuses with a friendly, sanitized error object ({ error }) in the same
 * convention afasTools uses. Secret values (literal, base64 and URL-encoded
 * forms) are scrubbed from every returned string.
 *
 * Stores are required lazily inside the execute path so requiring this module
 * never touches the DB (pure helpers stay unit-testable).
 */

const ssrfGuard = require('../core/customIntegrations/ssrfGuard');
const log = require('../telemetry/log');
const { fallback: fallbackSwallowed, bestEffort } = require('../utils/bestEffort');
const {
    EXACT_PLACEHOLDER_RE, DEFAULT_MAX_RESPONSE_CHARS, truncateBudget, scrubSecrets, getByDotPath,
    callRemoteMcpTool, resolveRunCredentials, requestHeaders, shapeResponse,
} = require('./customIntegrationSteps');
const { openRunGate, loadIntegration, authoriseRun } = require('./customIntegrationAccess');

const SLUG_RE = /^[a-z0-9]{4,16}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
const PATH_PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;
const CREDENTIAL_REF_RE = /\{\{credential\.([A-Za-z0-9_]+)\}\}/g;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_RAW_BYTES = 262144;           // hard cap on raw response bytes
const MAX_STRING_ARG_CHARS = 2000;      // runtime caps from the spec
const MAX_ARRAY_ARG_ITEMS = 100;
const DEFAULT_TIMEOUT_MS = 20000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const MIN_RESPONSE_CHARS = 1000;
const MAX_ERROR_MESSAGE_CHARS = 300;

// ssrfGuard's thrown messages are generic by contract and safe to surface.
const SAFE_GUARD_ERRORS = new Set([
    'Invalid URL.',
    'Only https:// URLs are allowed.',
    'Only http(s) URLs are allowed.',
    'URLs with embedded credentials are not allowed.',
    'Target address is not allowed.',
    'Target host could not be resolved.',
]);

// ─── Name parsing ──────────────────────────────────────────────

function isCustomIntegrationTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('cint_');
}

/**
 * 'cint_<slug>_<toolName>' → { slug, toolName } or null. The slug is the
 * segment between 'cint_' and the NEXT '_' — slugs never contain underscores,
 * so the split is unambiguous.
 */
function parsePrefixedName(toolName) {
    if (!isCustomIntegrationTool(toolName)) return null;
    const rest = toolName.slice('cint_'.length);
    const sep = rest.indexOf('_');
    if (sep === -1) return null;
    const slug = rest.slice(0, sep);
    const name = rest.slice(sep + 1);
    if (!SLUG_RE.test(slug) || !TOOL_NAME_RE.test(name)) return null;
    return { slug, toolName: name };
}

// ─── Pure helpers (exported for tests) ─────────────────────────

function clampInt(v, lo, hi, fallback) {
    const n = Number.isInteger(v) ? v : fallback;
    return Math.min(hi, Math.max(lo, n));
}

/**
 * Validate args against a tool's restricted JSON schema. REJECT, never
 * coerce: unknown props, missing required, wrong types, strings > 2000,
 * arrays > 100, enum mismatches. Returns { ok, errors: string[] }.
 * A missing/invalid schema means "no arguments accepted".
 */
function validateArgsAgainstSchema(schema, args) {
    const errors = [];
    const a = args == null ? {} : args;
    if (typeof a !== 'object' || Array.isArray(a)) {
        return { ok: false, errors: ['Arguments must be a JSON object.'] };
    }
    const s = (schema && typeof schema === 'object' && !Array.isArray(schema)) ? schema : {};
    const props = (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)) ? s.properties : {};
    const required = Array.isArray(s.required) ? s.required : [];

    for (const r of required) {
        if (typeof r === 'string' && a[r] === undefined) errors.push(`Missing required argument "${r}".`);
    }

    const checkScalar = (label, value, type, enumList) => {
        if (type === 'string') {
            if (typeof value !== 'string') { errors.push(`Argument ${label} must be a string.`); return; }
            if (value.length > MAX_STRING_ARG_CHARS) errors.push(`Argument ${label} exceeds ${MAX_STRING_ARG_CHARS} characters.`);
            if (Array.isArray(enumList) && !enumList.includes(value)) errors.push(`Argument ${label} must be one of: ${enumList.join(', ')}.`);
        } else if (type === 'integer') {
            if (!Number.isInteger(value)) errors.push(`Argument ${label} must be an integer.`);
        } else if (type === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`Argument ${label} must be a number.`);
        } else if (type === 'boolean') {
            if (typeof value !== 'boolean') errors.push(`Argument ${label} must be a boolean.`);
        } else {
            errors.push(`Argument ${label} has an unsupported declared type.`);
        }
    };

    for (const [key, value] of Object.entries(a)) {
        if (value === undefined) continue;
        const prop = props[key];
        if (!prop || typeof prop !== 'object' || Array.isArray(prop)) {
            errors.push(`Unknown argument "${key}".`);
            continue;
        }
        if (prop.type === 'array') {
            if (!Array.isArray(value)) { errors.push(`Argument "${key}" must be an array.`); continue; }
            if (value.length > MAX_ARRAY_ARG_ITEMS) { errors.push(`Argument "${key}" exceeds ${MAX_ARRAY_ARG_ITEMS} items.`); continue; }
            const items = (prop.items && typeof prop.items === 'object') ? prop.items : {};
            value.forEach((item, i) => checkScalar(`"${key}[${i}]"`, item, items.type, items.enum));
        } else {
            checkScalar(`"${key}"`, value, prop.type, prop.enum);
        }
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Build the final request URL for a tool call. Origin-pinned: path params
 * are encodeURIComponent'd, the substituted path is re-checked, the base
 * URL's path prefix is preserved (baseUrl https://h/v2 + '/x' → /v2/x), and
 * the resulting URL MUST share the baseUrl origin. Throws generic-message
 * errors (no secrets ever flow through here).
 */
function buildToolUrl(def, tool, args = {}) {
    const base = new URL(def.api.baseUrl);
    const template = String(tool.pathTemplate || '');
    const path = template.replace(PATH_PLACEHOLDER_RE, (_, name) => {
        const v = args[name];
        if (v === undefined || v === null) throw new Error(`Missing required path parameter "${name}".`);
        return encodeURIComponent(String(v));
    });
    // Re-checked AFTER substitution: encodeURIComponent leaves '.' bare, so a
    // '../admin' argument still reads as '..' here and is rejected.
    if (!/^\/(?!\/)/.test(path)) throw new Error('Resolved request path is invalid.');
    if (path.includes('..')) throw new Error('Resolved request path contains a traversal sequence.');
    // '\' becomes '/' under WHATWG URL parsing ('/\evil.com' → '//evil.com').
    if (/[?#\s\\]/.test(path)) throw new Error('Resolved request path is invalid.');

    const basePath = base.pathname.replace(/\/+$/, '');
    const url = new URL(basePath + path, base.origin);

    const qs = new URLSearchParams();
    const queryMap = (tool.query && typeof tool.query === 'object' && !Array.isArray(tool.query)) ? tool.query : {};
    for (const [key, raw] of Object.entries(queryMap)) {
        if (typeof raw === 'string') {
            const m = raw.match(EXACT_PLACEHOLDER_RE);
            if (m) {
                const v = args[m[1]];
                if (v === undefined || v === null) continue; // param-valued entries omitted when arg absent
                qs.append(key, Array.isArray(v) ? v.map(String).join(',') : String(v));
                continue;
            }
        }
        qs.append(key, String(raw)); // literals always sent
    }
    const q = qs.toString();
    if (q) url.search = q;

    if (url.origin !== base.origin) throw new Error('Resolved URL escaped the API origin.');
    return url;
}

/**
 * Render the auth value: 'basic' derives the Basic header from
 * credential.username/password; the templated types replace
 * {{credential.<key>}} with secret values. Thrown messages never include
 * secret material.
 */
function renderAuthValue(authCfg, secretObj) {
    const secrets = (secretObj && typeof secretObj === 'object') ? secretObj : {};
    if (authCfg.type === 'basic') {
        const u = secrets.username;
        const p = secrets.password;
        if (typeof u !== 'string' || typeof p !== 'string') {
            throw new Error('Stored credentials are incomplete — re-enter the username and password for this integration.');
        }
        return 'Basic ' + Buffer.from(`${u}:${p}`, 'utf8').toString('base64');
    }
    const template = authCfg.valueTemplate;
    if (typeof template !== 'string' || !template) {
        throw new Error('The integration auth template is missing.');
    }
    return template.replace(CREDENTIAL_REF_RE, (_, key) => {
        const v = secrets[key];
        if (typeof v !== 'string' || v === '') {
            throw new Error(`Stored credentials are missing "${key}" — re-enter credentials for this integration.`);
        }
        return v;
    });
}

/**
 * Substitute exact "{param}" string leaves of a JSON body template with the
 * TYPED argument value (a "{amount}" leaf with a numeric arg becomes a
 * number). Strings merely containing braces are literals. Object keys whose
 * (optional) argument is absent are dropped; absent array slots become null.
 */
function buildJsonBody(node, args) {
    if (typeof node === 'string') {
        const m = node.match(EXACT_PLACEHOLDER_RE);
        return m ? args[m[1]] : node;
    }
    if (Array.isArray(node)) {
        return node.map((v) => {
            const r = buildJsonBody(v, args);
            return r === undefined ? null : r;
        });
    }
    if (node && typeof node === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            const r = buildJsonBody(v, args);
            if (r !== undefined) out[k] = r;
        }
        return out;
    }
    return node;
}

/**
 * Short, sanitized message out of a vendor error body (JSON or XML-ish) —
 * never the raw body, never the URL/headers (afasTools convention).
 */
function extractErrorMessage(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return null;
    const t = bodyText.trim();
    let message = null;
    if (t.startsWith('{') || t.startsWith('[')) {
        try {
            const data = JSON.parse(t);
            const obj = Array.isArray(data) ? data[0] : data;
            if (obj && typeof obj === 'object') {
                message = obj.message || obj.error_description || obj.detail || obj.title
                    || (typeof obj.error === 'string' ? obj.error : (obj.error && obj.error.message))
                    || null;
            }
        } catch (err) { fallbackSwallowed('integrations/customIntegrationRunner:extractErrorMessage', err); /* not JSON after all */ }
    } else {
        const xmlMatch = t.match(/<(?:message|error|title)>([\s\S]*?)<\//i);
        if (xmlMatch) message = xmlMatch[1];
    }
    if (!message || typeof message !== 'string') return null;
    return message.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS) || null;
}

// ─── Response reading ──────────────────────────────────────────

/** Stream the body, aborting beyond capBytes. Returns a Buffer. */
async function readBodyCapped(response, capBytes) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > capBytes) {
            await reader.cancel().catch((e) => bestEffort('integrations/customIntegrationRunner:readBodyCapped', e));
            const err = /** @type {Error & { tooLarge?: boolean }} */ (new Error('Response exceeded the size limit.'));
            err.tooLarge = true;
            throw err;
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

// ─── Execution ─────────────────────────────────────────────────

/**
 * What a run reaches outside this file. The stores, the run gate and
 * entitlements load on first use, so requiring this module never touches the
 * database; a test passes its own.
 */
const RUN_DEPS = {
    loadRunGate: () => require('../core/customIntegrations/mcpLibrary/gate').loadRunGate(),
    integrationStore: () => require('../stores/orgCustomIntegrationStore'),
    connectionStore: () => require('../stores/integrationConnectionStore'),
    getUser: (/** @type {string} */ userId) => require('../stores/userStore').getUser(userId),
    hasCapability: (/** @type {string} */ capability, /** @type {{ userId: string, orgId: string }} */ who) =>
        require('../core/entitlements/entitlements').hasCapability(capability, who),
    callRemoteMcpTool,
    ssrfGuard,
    log,
};

/**
 * Definition: active runs the FROZEN activated_definition only; draft mode
 * runs the working copy.
 * @param {CustomIntegrationRow} integration
 * @param {boolean} isDraft
 */
function runnableDefinition(integration, isDraft) {
    const def = isDraft ? integration.definition : integration.activatedDefinition;
    if (!def || typeof def !== 'object' || !def.api || typeof def.api !== 'object' || !Array.isArray(def.tools)) {
        return { refusal: 'This custom integration has no runnable definition.' };
    }
    let baseOrigin;
    try { baseOrigin = new URL(def.api.baseUrl).origin; } catch { return { refusal: 'The integration base URL is invalid.' }; }
    return { def, baseOrigin };
}

/**
 * The tool a call names, with its checks in order. Method gate: non-GET
 * requires the allow_writes activation flag — strict for drafts too.
 * Arguments: reject, never coerce.
 * @param {CustomIntegrationRow} integration
 * @param {CustomIntegrationDefinition} def
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 */
function resolveToolCall(integration, def, toolName, args) {
    const tool = def.tools.find(t => t && typeof t === 'object' && t.name === toolName);
    if (!tool) return { refusal: `Tool "${toolName}" is not part of this integration.` };

    const method = typeof tool.method === 'string' ? tool.method.toUpperCase() : '';
    if (!METHODS.has(method)) return { refusal: 'This tool has an invalid HTTP method.' };
    if (method !== 'GET' && integration.allowWrites !== true) {
        return { refusal: 'This integration is read-only — write operations were not enabled at activation.' };
    }

    const check = validateArgsAgainstSchema(tool.parameters, args);
    if (!check.ok) return { refusal: `Invalid arguments: ${check.errors.join(' ')}` };
    const toolArgs = (args && typeof args === 'object') ? args : {};
    return { tool, method, toolArgs };
}

/**
 * URL build (origin pin asserted inside) + resolving SSRF check.
 * @param {typeof ssrfGuard} guard
 * @param {CustomIntegrationDefinition} def
 * @param {RestTool} tool
 * @param {Record<string, unknown>} toolArgs
 */
async function checkedToolUrl(guard, def, tool, toolArgs) {
    let url;
    try {
        url = buildToolUrl(def, tool, toolArgs);
    } catch (e) {
        return { refusal: e.message }; // buildToolUrl messages are generic
    }
    try {
        await guard.assertPublicHttpsTarget(url.href);
    } catch (e) {
        return { refusal: SAFE_GUARD_ERRORS.has(e?.message) ? e.message : 'Target address is not allowed.' };
    }
    return { url };
}

/**
 * Auth goes on LAST: the rendered value into the header or query parameter
 * its type names, and into the run's secret values so composed forms (e.g.
 * Basic b64) are scrubbed too.
 * @param {AuthConfig} auth
 * @param {unknown} secret
 * @param {{ url: URL, headers: Record<string, string>, run: { secretValues: string[] } }} request
 * @returns {{ refusal: string } | null}  why the value cannot be rendered
 */
function applyAuth(auth, secret, { url, headers, run }) {
    let authValue;
    try {
        authValue = renderAuthValue(auth, secret);
    } catch (e) {
        return { refusal: e.message };
    }
    run.secretValues.push(authValue);
    if (auth.type === 'bearer' || auth.type === 'basic') headers['Authorization'] = authValue;
    else if (auth.type === 'header') headers[String(auth.header)] = authValue;
    else if (auth.type === 'query') url.searchParams.append(String(auth.queryParam), authValue);
    return null;
}

/**
 * Headers (definition literals, requestHeaders), JSON body, then auth.
 * @param {{ def: CustomIntegrationDefinition, tool: RestTool, method: string, toolArgs: Record<string, unknown> }} call
 * @param {{ auth: AuthConfig, secret: unknown, url: URL, run: { secretValues: string[] } }} target
 * @returns {{ refusal: string } | { headers: Record<string, string>, body: string | undefined }}
 */
function buildRequest({ def, tool, method, toolArgs }, { auth, secret, url, run }) {
    const headers = requestHeaders(def, tool);
    let body;
    // fetch() rejects GET bodies outright, so a (validator-warned) GET
    // body template is dropped rather than failing the whole call.
    if (tool.body && tool.body.mode === 'json' && method !== 'GET') {
        body = JSON.stringify(buildJsonBody(tool.body.template, toolArgs) ?? {});
        if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/json';
        }
    }
    if (auth.type !== 'none') {
        const refused = applyAuth(auth, secret, { url, headers, run });
        if (refused) return refused;
    }
    return { headers, body };
}

/**
 * The request itself, under the definition's (clamped) timeout.
 * @param {typeof ssrfGuard} guard
 * @param {URL} url
 * @param {{ method: string, headers: Record<string, string>, body: string | undefined }} request
 * @param {unknown} definedTimeoutMs
 */
async function sendRequest(guard, url, { method, headers, body }, definedTimeoutMs) {
    const timeoutMs = clampInt(definedTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
        return { response: await guard.safeFetch(url.href, { method, headers, body, signal: controller.signal }) };
    } catch (err) {
        if ((err && err.name === 'AbortError') || controller.signal.aborted) {
            return { refusal: `The request timed out after ${Math.round(timeoutMs / 1000)}s.` };
        }
        // Never echo fetch internals — they can carry the URL (and with
        // query auth, the credential).
        return { refusal: SAFE_GUARD_ERRORS.has(err?.message) ? err.message : 'Could not reach the API host.' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Response: capped read, sanitized errors.
 * @param {Awaited<ReturnType<typeof ssrfGuard.safeFetch>>} response
 */
async function readAnswer(response) {
    let raw;
    try {
        raw = await readBodyCapped(response, MAX_RAW_BYTES);
    } catch (e) {
        return { refusal: e && e.tooLarge
            ? `The response exceeded the ${Math.round(MAX_RAW_BYTES / 1024)} KB limit. Narrow the request (filters, pagination).`
            : 'Failed to read the API response.' };
    }
    if (!response.ok) {
        const detail = extractErrorMessage(raw.toString('utf8'));
        return { refusal: detail ? `The API returned HTTP ${response.status}: ${detail}` : `The API returned HTTP ${response.status}.` };
    }
    return { raw };
}

/**
 * A 'rest' call from the checked integration to the shaped answer: the
 * definition, the tool with its method and arguments, the credentials
 * (provider 'custom:<integrationId>'), the origin-pinned and target-checked
 * URL, the request, the capped read, a best-effort usage stamp and the
 * budgeted result.
 * @param {typeof RUN_DEPS} deps
 * @param {{ secretValues: string[] }} run
 * @param {{ integration: CustomIntegrationRow, toolName: string,
 *   connStore: import('./customIntegrationAccess').ConnectionStore,
 *   args: Record<string, unknown>, isDraft: boolean, connectionOverrideId: string | null, userId: string, userOrg: string, integrationOrg: string }} call
 */
async function runRestCall(deps, run, { integration, connStore, toolName, args, isDraft, connectionOverrideId, userId, userOrg, integrationOrg }) {
    const defined = runnableDefinition(integration, isDraft);
    if ('refusal' in defined) return defined;
    const { def, baseOrigin } = defined;
    const resolved = resolveToolCall(integration, def, toolName, args);
    if ('refusal' in resolved) return resolved;
    const { tool, method, toolArgs } = resolved;

    const auth = (def.auth && typeof def.auth === 'object') ? def.auth : { type: 'none' };
    let connection = null;
    let secret = null;
    if (auth.type !== 'none') {
        const creds = await resolveRunCredentials(connStore, {
            integration, connectionOverrideId, userId, userOrg, integrationOrg, baseOrigin,
        });
        if ('refusal' in creds) return creds;
        ({ connection, secret } = creds);
        run.secretValues = Object.values(secret).filter(v => typeof v === 'string');
    }

    const target = await checkedToolUrl(deps.ssrfGuard, def, tool, toolArgs);
    if ('refusal' in target) return target;
    const { url } = target;
    const request = buildRequest({ def, tool, method, toolArgs }, { auth, secret, url, run });
    if ('refusal' in request) return request;

    deps.log.info(`[CustomIntegration] ${integration.slug}.${toolName} (${method})`);

    const sent = await sendRequest(deps.ssrfGuard, url, { method, ...request }, def.api.timeoutMs);
    if ('refusal' in sent) return sent;
    const answer = await readAnswer(sent.response);
    if ('refusal' in answer) return answer;

    if (connection) {
        try { await connStore.touchLastUsed(connection.id); } catch (err) { bestEffort('integrations/customIntegrationRunner:executeCustomIntegrationTool', err); /* best effort */ }
    }

    const maxChars = clampInt(def.api.maxResponseChars, MIN_RESPONSE_CHARS, DEFAULT_MAX_RESPONSE_CHARS, DEFAULT_MAX_RESPONSE_CHARS);
    return shapeResponse(sent.response, answer.raw, tool, maxChars, run.secretValues);
}

/**
 * The steps of a run, in order; each refusal ends it. `run.secretValues`
 * holds the credential material loaded so far, for the caller's scrub.
 * @param {string} prefixedName
 * @param {Record<string, unknown>} args
 * @param {{ userId: string | null, draftIntegration: CustomIntegrationRow | null, connectionOverrideId: string | null, unattended: boolean }} opts
 * @param {typeof RUN_DEPS} deps
 * @param {{ secretValues: string[] }} run
 */
async function runToolCall(prefixedName, args, { userId, draftIntegration, connectionOverrideId, unattended }, deps, run) {
    const isDraft = !!draftIntegration;
    const gate = await openRunGate(deps, isDraft);
    if ('refusal' in gate) return gate;
    const parsed = parsePrefixedName(prefixedName);
    if (!parsed) return { refusal: 'Unknown custom integration tool.' };
    const loaded = await loadIntegration(deps, gate, { prefixedName, slug: parsed.slug, draftIntegration });
    if ('refusal' in loaded) return loaded;
    const { integration, connStore } = loaded;
    const access = await authoriseRun(deps, connStore, integration, { userId, isDraft, unattended });
    if ('refusal' in access) return access;

    // mcp_remote → delegate, then apply the same scrub/truncate.
    if (integration.kind === 'mcp_remote') {
        return deps.callRemoteMcpTool(integration, {
            prefixedName, toolName: parsed.toolName, args, userId, secretValues: run.secretValues,
        });
    }
    return runRestCall(deps, run, {
        integration, connStore, toolName: parsed.toolName, args, isDraft, connectionOverrideId, userId, ...access,
    });
}

/**
 * Execute a cint_<slug>_<tool> call. Returns afasTools-style result objects:
 * { error } on refusal/failure, or { status, result, truncated?, message? }
 * (result is the truncated serialized response). Every returned string is
 * scrubbed of credential material.
 *
 * @param {string} prefixedName  full tool name, e.g. cint_ab12cd34ef5_list_invoices
 * @param {Record<string, unknown>} args  model-provided arguments
 * @param {{ userId?: string | null, draftIntegration?: CustomIntegrationRow | null,
 *   connectionOverrideId?: string | null, unattended?: boolean }} [opts]  `userId` is the
 *   running user (org + credential resolution); `draftIntegration` a shaped row for the
 *   builder's test route, which skips the status and capability checks (the route
 *   pre-authorizes) and runs the WORKING definition; `connectionOverrideId` an explicit
 *   connection (test route); `unattended` an automated run (refused for now)
 * @param {typeof RUN_DEPS} [deps]  the collaborators (tests)
 */
async function executeCustomIntegrationTool(prefixedName, args, {
    userId = null, draftIntegration = null, connectionOverrideId = null, unattended = false,
} = {}, deps = RUN_DEPS) {
    const run = { secretValues: /** @type {string[]} */ ([]) };
    try {
        const out = await runToolCall(prefixedName, args, { userId, draftIntegration, connectionOverrideId, unattended }, deps, run);
        return 'refusal' in out ? { error: scrubSecrets(String(out.refusal), run.secretValues) } : out;
    } catch (err) {
        // Unexpected failure: log a scrubbed message, return a fixed string
        // (never err.message — it could carry a URL with query auth).
        deps.log.warn(`[CustomIntegration] ${String(prefixedName).slice(0, 80)} failed: ${scrubSecrets(String(err && err.message), run.secretValues)}`);
        return { error: 'Custom integration request failed.' };
    }
}

module.exports = {
    isCustomIntegrationTool,
    parsePrefixedName,
    executeCustomIntegrationTool,
    // Pure helpers exported for unit tests.
    buildToolUrl,
    renderAuthValue,
    validateArgsAgainstSchema,
    scrubSecrets,
    truncateBudget,
    // Tests / debugging only
    _internals: { buildJsonBody, extractErrorMessage, getByDotPath, clampInt, readBodyCapped, RUN_DEPS },
};

/** @typedef {{ type?: string, valueTemplate?: string, header?: string, queryParam?: string }} AuthConfig */
/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../stores/orgCustomIntegrationStore').getBySlug>>>} CustomIntegrationRow */

/**
 * One tool of a 'rest' definition.
 * @typedef {{ name?: string, method?: string, pathTemplate?: string, query?: Record<string, unknown>,
 *   headers?: Record<string, unknown>, body?: { mode?: string, template?: unknown }, parameters?: Record<string, unknown>,
 *   resultPath?: string }} RestTool
 */

/**
 * A custom integration definition: 'rest' (api/tools/auth) or 'mcp_remote' (mcp).
 * @typedef {{ meta?: { source?: string },
 *   api?: { baseUrl?: string, defaultHeaders?: Record<string, unknown>, timeoutMs?: number, maxResponseChars?: number },
 *   tools?: RestTool[], auth?: AuthConfig, mcp?: import('../core/customIntegrations/customMcpClient').McpBlock,
 *   [key: string]: unknown }} CustomIntegrationDefinition
 */
