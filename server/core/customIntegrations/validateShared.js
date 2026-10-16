/**
 * The shared pieces of custom-integration definition validation
 * (./validateCustomIntegration.js): limits, patterns, the header deny-list,
 * the injection lint, the SSRF host screen, the credential-leak walk, and the
 * field checks every block uses. Each check reports through `r`
 * ({ pushE, pushW, pushLint }) — see makeReporter.
 */

let ssrfGuard = null;
try {
    ssrfGuard = require('./ssrfGuard');
} catch {
    // ssrfGuard ships alongside this module; until it is on disk we fall
    // back to URL-parse-only checks. The runner performs its own resolving
    // SSRF check before every request, so the runtime guarantee holds.
    ssrfGuard = null;
}

const MAX_DEF_CHARS = 131072;
const MIN_TOOLS = 1;
const MAX_TOOLS = 30;
const MAX_PROPERTIES_PER_TOOL = 20;
const MAX_QUERY_ENTRIES = 15;
const MAX_HEADER_ENTRIES = 15;
const MAX_CREDENTIALS = 8;
const MAX_NOTES_CHARS = 4000;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_ENUM_ENTRY_CHARS = 200;
const MAX_TOOL_ALLOW_LIST = 100;
const MAX_COMBINED_NAME_CHARS = 64;
const MAX_BODY_TEMPLATE_DEPTH = 8;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const MIN_RESPONSE_CHARS = 1000;
const MAX_RESPONSE_CHARS = 30000;

const SLUG_RE = /^[a-z0-9]{4,16}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
const CREDENTIAL_KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;
const PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const QUERY_NAME_RE = /^[A-Za-z0-9_.[\]-]{1,64}$/;
const AUTH_QUERY_PARAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const RESULT_PATH_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const PATH_PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;
const EXACT_PLACEHOLDER_RE = /^\{([A-Za-z0-9_]+)\}$/;
const CREDENTIAL_REF_RE = /\{\{credential\.([A-Za-z0-9_]+)\}\}/g;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_TYPES = new Set(['bearer', 'header', 'query', 'basic', 'none']);
const MCP_AUTH_STYLES = new Set(['bearer', 'header', 'none']);
const PAGINATION_STYLES = new Set(['page', 'offset', 'cursor', 'none']);
const PARAM_SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array']);

// Transport / auth / proxy headers the runner owns; definitions may never
// set them (case-insensitive; prefixes cover proxy-* and x-forwarded-*).
const DENIED_HEADERS = new Set([
    'host', 'authorization', 'cookie', 'set-cookie', 'content-length',
    'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
]);
const DENIED_HEADER_PREFIXES = ['proxy-', 'x-forwarded-'];

// Imperative-injection lint over model-visible prose (tool descriptions,
// meta.notes). Warning normally; promoted to error under strict (activation).
const INJECTION_PHRASES = [
    'ignore previous', 'ignore all previous', 'disregard', 'system prompt',
    'you must always', 'always call', 'always send', 'do not tell',
    'password', 'secret key', 'api key', 'credential', 'token',
];

// The only two paths where '{{credential.*}}' is legal.
const VALUE_TEMPLATE_PATHS = new Set(['auth.valueTemplate', 'mcp.valueTemplate']);

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function isDeniedHeader(name, { forAuth = false } = {}) {
    const n = String(name).toLowerCase();
    // auth.header / mcp.header is where the credential is injected, so
    // 'Authorization' is legal there (bearer is just a shorthand for it).
    if (forAuth && n === 'authorization') return false;
    if (DENIED_HEADERS.has(n)) return true;
    return DENIED_HEADER_PREFIXES.some(p => n.startsWith(p));
}

function findInjectionPhrases(text) {
    const lower = String(text).toLowerCase();
    return INJECTION_PHRASES.filter(p => lower.includes(p));
}

/**
 * Sync, DNS-less host screen. ssrfGuard.normalizeHostname classifies the
 * host as a literal IP ('ip4'/'ip6', canonical = normalized address or null
 * when numeric-but-malformed) or a DNS 'name'. Literal IPs are range-checked
 * via isForbiddenAddress (which is fail-closed and only accepts literals —
 * never feed it a DNS name). Names get the full resolving check at request
 * time; here we only reject ones that can never be public (no dot, e.g.
 * 'localhost'/'intranet', or *.localhost).
 */
function hostIsForbidden(hostname) {
    if (!ssrfGuard) return false;
    try {
        const norm = ssrfGuard.normalizeHostname(hostname);
        if (norm && typeof norm === 'object') {
            if (norm.kind === 'name') {
                const name = norm.canonical;
                return !name || !name.includes('.') || name.endsWith('.localhost');
            }
            return norm.canonical === null || !!ssrfGuard.isForbiddenAddress(norm.canonical);
        }
        // Defensive fallback for a string-returning normalize variant.
        const s = typeof norm === 'string' && norm ? norm : String(hostname).toLowerCase();
        if (/^[0-9.]+$/.test(s) || s.includes(':')) return !!ssrfGuard.isForbiddenAddress(s);
        return !s.includes('.') || s.endsWith('.localhost');
    } catch {
        // A guard that throws on this hostname is rejecting hostile input.
        return true;
    }
}

/**
 * Walk the whole definition and report every string (or key) containing
 * '{{credential.' outside the two sanctioned valueTemplate paths.
 */
function findCredentialLeaks(value, path, out) {
    if (typeof value === 'string') {
        if (!VALUE_TEMPLATE_PATHS.has(path) && value.includes('{{credential.')) out.push(path || '(root)');
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) findCredentialLeaks(value[i], `${path}[${i}]`, out);
        return;
    }
    if (value && typeof value === 'object') {
        for (const k of Object.keys(value)) {
            const childPath = path ? `${path}.${k}` : k;
            if (k.includes('{{credential.')) out.push(childPath);
            findCredentialLeaks(value[k], childPath, out);
        }
    }
}

/**
 * Collect exact-match "{param}" string leaves from a JSON body template.
 * Strings that merely *contain* braces are literals per the spec.
 */
function collectBodyPlaceholders(node, path, depth, out) {
    if (depth > MAX_BODY_TEMPLATE_DEPTH) { out.tooDeep.push(path); return; }
    if (typeof node === 'string') {
        const m = node.match(EXACT_PLACEHOLDER_RE);
        if (m) out.placeholders.push({ name: m[1], path });
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((v, i) => collectBodyPlaceholders(v, `${path}[${i}]`, depth + 1, out));
        return;
    }
    if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) collectBodyPlaceholders(node[k], `${path}.${k}`, depth + 1, out);
    }
    // number / boolean / null leaves are literals.
}

/**
 * The error/warning collector one validation run reports through. The
 * promotable lint set goes to warnings normally and to blocking errors under
 * `strict` (activation).
 * @param {boolean} strict
 */
function makeReporter(strict) {
    const errors = [];
    const warnings = [];
    const pushE = (rec) => errors.push({ ...rec, severity: 'error' });
    const pushW = (rec) => warnings.push({ ...rec, severity: 'warning' });
    const pushLint = (rec) => (strict ? pushE(rec) : pushW(rec));
    return { errors, warnings, pushE, pushW, pushLint };
}

function checkHttpsUrl(r, raw, { path, codePrefix, allowQuery, requiredLabel }) {
    if (typeof raw !== 'string' || !raw) {
        r.pushE({ code: `${codePrefix}_invalid`, path, message: `${requiredLabel} is required and must be a string URL.`, hint: 'Provide an absolute https URL.' });
        return;
    }
    let u;
    try { u = new URL(raw); } catch {
        r.pushE({ code: `${codePrefix}_invalid`, path, message: `${requiredLabel} "${raw}" is not a valid URL.`, hint: 'Provide an absolute https URL like https://api.example.com/v2.' });
        return;
    }
    if (u.protocol !== 'https:') {
        r.pushE({ code: `${codePrefix}_not_https`, path, message: `${requiredLabel} must use https (got ${u.protocol.replace(':', '')}).`, hint: 'Plain-text transports are not allowed for credentialed requests.' });
    }
    if (!u.hostname) {
        r.pushE({ code: `${codePrefix}_invalid`, path, message: `${requiredLabel} has no hostname.`, hint: 'Provide a full origin like https://api.example.com.' });
    }
    if (u.username || u.password) {
        r.pushE({ code: `${codePrefix}_userinfo`, path, message: `${requiredLabel} must not embed userinfo (user:pass@).`, hint: 'Move credentials into auth.credentials; they are stored encrypted per connection.' });
    }
    if (!allowQuery && (u.search || u.hash)) {
        r.pushE({ code: `${codePrefix}_query_fragment`, path, message: `${requiredLabel} must not contain a query string or fragment.`, hint: 'Put query parameters on individual tools instead.' });
    }
    if (u.hostname && hostIsForbidden(u.hostname)) {
        r.pushE({ code: `${codePrefix}_forbidden_host`, path, message: `${requiredLabel} host "${u.hostname}" resolves to a private/forbidden address class.`, hint: 'Only public vendor hosts are allowed; localhost, private ranges and link-local addresses are blocked.' });
    }
}

function checkHeaderMap(r, map, basePath, codes, labelPrefix) {
    const names = Object.keys(map);
    if (names.length > MAX_HEADER_ENTRIES) {
        r.pushE({ code: codes.tooMany, path: basePath, message: `${labelPrefix} has ${names.length} headers; the cap is ${MAX_HEADER_ENTRIES}.`, hint: 'Remove headers the API does not strictly need.' });
    }
    for (const name of names) {
        const at = `${basePath}.${name}`;
        if (!HEADER_NAME_RE.test(name)) {
            r.pushE({ code: codes.name, path: at, message: `${labelPrefix} header name "${name}" is invalid.`, hint: 'Header names must match ^[A-Za-z0-9-]{1,64}$.' });
        } else if (isDeniedHeader(name)) {
            r.pushE({ code: codes.denied, path: at, message: `${labelPrefix} header "${name}" is not allowed.`, hint: 'Transport, auth, cookie and proxy/forwarding headers are managed by the runner and cannot be set in a definition.' });
        }
        const v = map[name];
        if (typeof v !== 'string') {
            r.pushE({ code: codes.value, path: at, message: `${labelPrefix} header "${name}" value must be a literal string.`, hint: 'Headers cannot reference parameters or credentials.' });
        } else if (v.includes('{{') || EXACT_PLACEHOLDER_RE.test(v)) {
            r.pushE({ code: codes.value, path: at, message: `${labelPrefix} header "${name}" value must be a literal — no {{…}} or {param} templating.`, hint: 'Only auth.valueTemplate may carry a credential reference; parameter values belong in query or body.' });
        }
    }
}

function checkValueTemplate(r, vt, declaredKeys, path, codePrefix) {
    const refs = [];
    const leftover = vt.replace(CREDENTIAL_REF_RE, (m, key) => { refs.push(key); return ''; });
    if (leftover.includes('{{') || leftover.includes('}}')) {
        r.pushE({ code: `${codePrefix}.value_template_invalid`, path, message: 'valueTemplate may only contain literal text plus {{credential.<key>}} references.', hint: 'Check for typos in the {{credential.…}} syntax; keys must match ^[a-z][a-z0-9_]{0,40}$.' });
    }
    for (const key of refs) {
        if (!declaredKeys.has(key)) {
            r.pushE({ code: `${codePrefix}.credential_key_undeclared`, path, message: `valueTemplate references undeclared credential key "${key}".`, hint: `Declare it in ${codePrefix}.credentials, or fix the reference. Declared keys: ${[...declaredKeys].join(', ') || '(none)'}.` });
        }
    }
    if (refs.length === 0) {
        r.pushW({ code: `${codePrefix}.value_template_static`, path, message: 'valueTemplate references no {{credential.*}} key — a literal secret embedded here would be stored unencrypted in the definition.', hint: 'Declare a credential and reference it, e.g. "Bearer {{credential.api_key}}".' });
    }
}

function checkCredentialList(r, creds, basePath, codePrefix) {
    const declared = new Set();
    if (creds === undefined) return declared;
    if (!Array.isArray(creds)) {
        r.pushE({ code: `${codePrefix}.credentials_invalid`, path: `${basePath}.credentials`, message: 'credentials must be an array of { key, label, description }.', hint: 'List the secrets the user must supply when connecting.' });
        return declared;
    }
    if (creds.length > MAX_CREDENTIALS) {
        r.pushE({ code: `${codePrefix}.credentials_too_many`, path: `${basePath}.credentials`, message: `${creds.length} credentials declared; the cap is ${MAX_CREDENTIALS}.`, hint: 'Most APIs need 1-2 secrets; remove the rest.' });
    }
    creds.forEach((c, i) => {
        const at = `${basePath}.credentials[${i}]`;
        if (!isObject(c)) {
            r.pushE({ code: `${codePrefix}.credentials_invalid`, path: at, message: 'Each credential must be an object { key, label, description }.', hint: 'Example: { "key": "api_key", "label": "API key" }.' });
            return;
        }
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored, bounded quantifier: no backtracking
        if (typeof c.key !== 'string' || !CREDENTIAL_KEY_RE.test(c.key)) {
            r.pushE({ code: `${codePrefix}.credential_key_invalid`, path: `${at}.key`, message: `Credential key ${JSON.stringify(c.key)} must match ^[a-z][a-z0-9_]{0,40}$.`, hint: 'Lowercase snake_case, starting with a letter.' });
        } else if (declared.has(c.key)) {
            r.pushE({ code: `${codePrefix}.credential_key_duplicate`, path: `${at}.key`, message: `Duplicate credential key "${c.key}".`, hint: 'Keys must be unique.' });
        } else {
            declared.add(c.key);
        }
        if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 200) {
            r.pushE({ code: `${codePrefix}.credential_label_invalid`, path: `${at}.label`, message: 'Each credential needs a non-empty label (max 200 chars).', hint: 'The label is shown on the connect form.' });
        }
        if (c.description !== undefined && (typeof c.description !== 'string' || c.description.length > 1000)) {
            r.pushE({ code: `${codePrefix}.credential_description_invalid`, path: `${at}.description`, message: 'Credential description must be a string of at most 1000 chars.', hint: 'Explain where the user finds this secret, or omit it.' });
        }
    });
    return declared;
}

function checkIntRange(r, v, lo, hi, path, code, label) {
    if (v === undefined) return;
    if (!Number.isInteger(v) || v < lo || v > hi) {
        r.pushE({ code, path, message: `${label} must be an integer between ${lo} and ${hi} (got ${JSON.stringify(v)}).`, hint: `Pick a value in [${lo}, ${hi}] or omit it for the default.` });
    }
}

module.exports = {
    MAX_DEF_CHARS, MIN_TOOLS, MAX_TOOLS, MAX_PROPERTIES_PER_TOOL, MAX_QUERY_ENTRIES, MAX_NOTES_CHARS,
    MAX_DESCRIPTION_CHARS, MAX_ENUM_ENTRY_CHARS, MAX_TOOL_ALLOW_LIST, MAX_COMBINED_NAME_CHARS,
    MAX_BODY_TEMPLATE_DEPTH, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_RESPONSE_CHARS, MAX_RESPONSE_CHARS,
    SLUG_RE, TOOL_NAME_RE, PARAM_NAME_RE, HEADER_NAME_RE, QUERY_NAME_RE, AUTH_QUERY_PARAM_RE, RESULT_PATH_RE,
    PATH_PLACEHOLDER_RE, EXACT_PLACEHOLDER_RE, METHODS, AUTH_TYPES, MCP_AUTH_STYLES, PAGINATION_STYLES,
    PARAM_SCALAR_TYPES, PARAM_TYPES,
    isObject, isDeniedHeader, findInjectionPhrases, findCredentialLeaks, collectBodyPlaceholders,
    makeReporter, checkHttpsUrl, checkHeaderMap, checkValueTemplate, checkCredentialList, checkIntRange,
};
