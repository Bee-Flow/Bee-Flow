/**
 * Turning "install this MCP server" into an mcp_remote custom-integration
 * definition, and checking an endpoint before anything is stored.
 *
 * The library never takes a definition from the browser. It takes a catalogue
 * id (or, where the policy allows, an endpoint plus an auth STYLE) and builds
 * the definition here, so the auth header name, the value template and the
 * credential field are always this module's, never the caller's.
 */

const { HttpError } = require('../../http/errors');
const { getCatalogEntry } = require('./catalog');
const { LIBRARY_SOURCE } = require('./gate');
const deps = require('./deps');

const PROBE_TIMEOUT_MS = 20_000;
const MAX_TOOL_DESCRIPTION_CHARS = 400;
const CREDENTIAL_MAX_CHARS = 4096;

// The single credential field a custom endpoint gets.
const CUSTOM_CREDENTIAL = Object.freeze({ key: 'token', label: 'API key or token' });
// Custom header names an admin may pick for a key; Authorization goes through
// the 'bearer' style. Anything managed by the transport is refused by the
// validator as well, this list just keeps the UI honest.
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The auth part of a definition.
 *   { authStyle: 'none', credential: null }
 * | { authStyle: 'bearer'|'header', header?, valueTemplate, credential: { key, label } }
 */
function authFromCatalog(entry) {
    const a = entry.auth || { style: 'none' };
    if (a.style === 'none') return { authStyle: 'none', credential: null };
    const credential = { key: a.credential.key, label: a.credential.label };
    if (a.style === 'bearer') {
        return { authStyle: 'bearer', valueTemplate: `Bearer {{credential.${credential.key}}}`, credential };
    }
    return { authStyle: 'header', header: a.header, valueTemplate: `{{credential.${credential.key}}}`, credential };
}

function authFromCustom(auth) {
    const style = auth && auth.style;
    if (!style || style === 'none') return { authStyle: 'none', credential: null };
    if (style === 'bearer') {
        return { authStyle: 'bearer', valueTemplate: `Bearer {{credential.${CUSTOM_CREDENTIAL.key}}}`, credential: { ...CUSTOM_CREDENTIAL } };
    }
    if (style === 'header') {
        const header = typeof auth.header === 'string' ? auth.header.trim() : '';
        if (!HEADER_NAME_RE.test(header)) throw new HttpError(400, 'invalid_header', 'Give the header name the server expects, for example X-Api-Key.');
        // Checked here, before any connection: the probe never runs the
        // validator, and Host/Cookie/proxy headers are the transport's.
        const { isDeniedHeader } = require('../validateCustomIntegration');
        if (isDeniedHeader(header, { forAuth: true })) {
            throw new HttpError(400, 'invalid_header', `"${header}" is managed by the connection itself and cannot carry a key.`);
        }
        return { authStyle: 'header', header, valueTemplate: `{{credential.${CUSTOM_CREDENTIAL.key}}}`, credential: { ...CUSTOM_CREDENTIAL } };
    }
    throw new HttpError(400, 'invalid_auth', 'Authentication is none, bearer or header.');
}

/**
 * What an install request points at: the endpoint, its auth, and the
 * catalogue entry when there is one. Throws a 4xx HttpError for anything the
 * caller got wrong. Does NOT apply the policy (the caller does, so that a
 * probe and an install refuse with the same words).
 */
function resolveTarget({ catalogId = null, url = null, auth = null }) {
    if (catalogId) {
        const entry = getCatalogEntry(catalogId);
        if (!entry) throw new HttpError(404, 'catalog_entry_not_found', 'That server is not in the library.');
        // A self-hosted entry takes the admin's own instance URL; an official
        // one is pinned to the vendor endpoint whatever the request says.
        const endpoint = entry.selfHosted ? String(url || '').trim() : entry.url;
        if (!endpoint) throw new HttpError(400, 'url_required', `Enter the address of your ${entry.name} instance.`);
        return { url: endpoint, auth: authFromCatalog(entry), entry };
    }
    const endpoint = String(url || '').trim();
    if (!endpoint) throw new HttpError(400, 'url_required', 'Enter the server address.');
    return { url: endpoint, auth: authFromCustom(auth), entry: null };
}

/** The mcp block for a definition (or for a throwaway probe). */
function mcpBlock({ url, auth, toolAllowList = null, discoveredTools = null }) {
    const mcp = { url, authStyle: auth.authStyle };
    if (auth.authStyle !== 'none') {
        mcp.valueTemplate = auth.valueTemplate;
        mcp.credentials = [{ key: auth.credential.key, label: auth.credential.label }];
        if (auth.authStyle === 'header') mcp.header = auth.header;
    }
    if (Array.isArray(toolAllowList)) mcp.toolAllowList = toolAllowList;
    if (Array.isArray(discoveredTools)) mcp.discoveredTools = discoveredTools;
    return mcp;
}

/**
 * Tool records kept in the definition for the admin UI (which tools exist,
 * which are switched on, what the server says they do). No schemas: those
 * are re-read from the server whenever the tool set changes, and keeping
 * them here would push a big server past the definition size cap.
 * `{{` is defused because the validator rightly refuses any definition that
 * carries a credential-reference lookalike.
 */
// Every brace that touches another brace gets a space after it, so no run of
// braces ('{{', '{{{', …) survives: a single pass of '{{' → '{ {' leaves
// '{{{' as '{ {{'.
const defuseBraces = (s) => s.replace(/\{(?=\{)/g, '{ ').replace(/\}(?=\})/g, '} ');

function slimTools(tools) {
    return (Array.isArray(tools) ? tools : []).map(t => {
        const hints = t.annotations || {};
        return {
            name: t.name,
            // Defused first, cut second: the cap holds after the inserted spaces.
            description: defuseBraces(String(t.description || '')).slice(0, MAX_TOOL_DESCRIPTION_CHARS),
            readOnly: typeof hints.readOnlyHint === 'boolean' ? hints.readOnlyHint : null,
            destructive: typeof hints.destructiveHint === 'boolean' ? hints.destructiveHint : null,
        };
    });
}

function buildDefinition({ url, auth, entry = null, discoveredTools, toolAllowList }) {
    const meta = { source: LIBRARY_SOURCE };
    if (entry) meta.catalogId = entry.id;
    if (entry && entry.docsUrl) meta.docsUrl = entry.docsUrl;
    return {
        specVersion: 1,
        meta,
        mcp: mcpBlock({ url, auth, toolAllowList, discoveredTools: slimTools(discoveredTools) }),
    };
}

function secretObjectFor(auth, value) {
    if (auth.authStyle === 'none' || !auth.credential) return null;
    if (typeof value !== 'string' || !value.trim()) return null;
    return { [auth.credential.key]: value.trim() };
}

function checkCredentialValue(value) {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string') throw new HttpError(400, 'invalid_credential', 'The key must be text.');
    if (value.length > CREDENTIAL_MAX_CHARS) {
        throw new HttpError(400, 'invalid_credential', `The key is at most ${CREDENTIAL_MAX_CHARS} characters.`);
    }
}

/**
 * Why a connection attempt failed, as a code the UI can turn into a sentence.
 * The underlying messages come from ssrfGuard (deliberately generic) and the
 * MCP SDK ("Error POSTing to endpoint (HTTP 401): …"), already scrubbed of
 * the credential by customMcpClient.
 */
function classifyConnectError(err) {
    const msg = String((err && err.message) || err || '');
    if (err && err.code === 'probe_timeout') return 'timeout';
    if (/Target address is not allowed/i.test(msg)) return 'blocked_address';
    if (/could not be resolved|ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'unresolvable';
    if (/Only https/i.test(msg)) return 'not_https';
    if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid[_ ]token/i.test(msg)) return 'auth_failed';
    if (/\b404\b|\b405\b|not found/i.test(msg)) return 'not_mcp';
    if (/redirect/i.test(msg)) return 'redirect';
    if (/timed? ?out|ETIMEDOUT|aborted/i.test(msg)) return 'timeout';
    return 'unreachable';
}

const CONNECT_ERROR_TEXT = {
    timeout: 'The server did not answer within 20 seconds.',
    blocked_address: 'That address points to a private or internal network, which is never allowed.',
    unresolvable: 'That host name does not exist.',
    not_https: 'Only https addresses are allowed.',
    auth_failed: 'The server refused the key. Check that it is correct and has the right permissions.',
    auth_required: 'This server only answers with a key. Add one and try again.',
    not_mcp: 'There is no MCP server at that address.',
    redirect: 'The server redirected the request, which is not followed for safety. Use the final address.',
    unreachable: 'The server could not be reached.',
};

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const e = new Error('Connection timed out.');
            e.code = 'probe_timeout';
            reject(e);
        }, ms);
        if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Connect, list the tools, disconnect. Throws HttpError(422, 'connect_<code>')
 * on failure. `toolAllowList` null = every advertised tool.
 */
async function discover({ url, auth, secretObject = null, toolAllowList = null }) {
    const client = deps.mcpClient();
    const probe = { id: 'mcp-library-probe', definition: { specVersion: 1, mcp: mcpBlock({ url, auth, toolAllowList }) } };
    try {
        return await withTimeout(client.discoverTools(probe, { secretObject }), PROBE_TIMEOUT_MS);
    } catch (err) {
        let code = classifyConnectError(err);
        if (code === 'auth_failed' && !secretObject) code = 'auth_required';
        throw new HttpError(422, `connect_${code}`, CONNECT_ERROR_TEXT[code]);
    }
}

module.exports = {
    PROBE_TIMEOUT_MS,
    CUSTOM_CREDENTIAL,
    authFromCatalog,
    authFromCustom,
    resolveTarget,
    mcpBlock,
    slimTools,
    buildDefinition,
    secretObjectFor,
    checkCredentialValue,
    classifyConnectError,
    discover,
};
