/**
 * Structured query parameters of an http_request step (`step.query`).
 *
 * Why this exists: an API such as `?builder[0][orderByDesc]=created_at&…` wants a
 * nested query, and the only way to send one used to be to hand-encode it into
 * the URL, with every dynamic part (domain, page size) frozen into the text.
 * A step now describes the parameters as data and the runner serialises them
 * after its bindings are resolved:
 *
 *   { mode: 'fields', items: [{ key, value }] }   one row per parameter
 *   { mode: 'json',   json: '{"builder":[{"paginate": {{steps.a.output.n}} }]}' }
 *   arrayFormat: 'indices' (default, the `qs`/n8n/PHP style a[0][b]=c)
 *                'brackets' (a[]=c)  'repeat' (a=c&a=d)  'comma' (a=c,d)
 *
 * A step without `query` never reaches this module, so existing steps behave
 * exactly as before. Keys and values are resolved with the same template engine
 * as the url, headers and body; JSON mode uses interpolateJsonBody so a bound
 * number stays a number and a text with quotes cannot break the document.
 *
 * Privacy: nothing here logs a value. Errors name the setting and the reason,
 * never the content (a JSON parse error from Node quotes the text, so ours does not).
 */

'use strict';

const { interpolateTemplate, interpolateJsonBody, resolveValue } = require('../../automation/bind');

const ARRAY_FORMATS = Object.freeze(['indices', 'brackets', 'repeat', 'comma']);
const QUERY_MODES = Object.freeze(['fields', 'json']);
// A runaway binding (a 50 000 row list under one key) must not build a URL no server accepts.
const MAX_PAIRS = 500;

/** An Error the step card can explain (utils/stepErrorInfo.js reads `stepErrorCode` + `userReason`). */
function queryError(reason) {
    const err = new Error(`http_request: the query parameters cannot be used: ${reason}`);
    err.stepErrorCode = 'http_query_invalid';
    err.userReason = reason;
    return err;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v === undefined || v === null || v === '';
const isScalar = (v) => v === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof v);

/** Same escaping as `qs` and n8n: brackets in a key are encoded too (`a%5B0%5D`). */
const enc = (s) => encodeURIComponent(s);

/**
 * Flatten a value into [key, text] pairs. Null, undefined and '' are dropped;
 * empty arrays and objects contribute nothing.
 */
function flatten(prefix, value, format, out) {
    if (isEmpty(value)) return;
    if (Array.isArray(value)) {
        if (format === 'comma' && value.every(isScalar)) {
            const joined = value.filter((v) => !isEmpty(v)).map(String).join(',');
            if (joined) out.push([prefix, joined]);
            return;
        }
        value.forEach((item, i) => {
            if (format === 'repeat') flatten(prefix, item, format, out);
            else if (format === 'brackets') flatten(`${prefix}[]`, item, format, out);
            else flatten(`${prefix}[${i}]`, item, format, out);
        });
        return;
    }
    if (isObj(value)) {
        for (const [k, v] of Object.entries(value)) flatten(prefix ? `${prefix}[${k}]` : k, v, format, out);
        return;
    }
    if (value instanceof Date) { out.push([prefix, value.toISOString()]); return; }
    out.push([prefix, String(value)]);
}

/** Pairs of a whole object (the root of a JSON document, or a map of key → value). */
function pairsOfObject(obj, format) {
    const out = [];
    for (const [k, v] of Object.entries(obj)) flatten(k, v, format, out);
    return out;
}

/** The text of a query pair list: `a%5B0%5D=1&b=2`. */
function encodePairs(pairs) {
    return pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
}

const SOLE_PLACEHOLDER_RE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

/** The text of a Node JSON parse failure with the quoted content removed. */
function jsonProblem(e) {
    const m = /position (\d+)/.exec(String(e && e.message));
    return `the JSON is not valid${m ? ` (near character ${m[1]})` : ''}. Check commas, quotes and brackets.`;
}

/**
 * The [key, value] pairs a step's `query` stands for, after resolving its
 * bindings. Throws queryError for a setting the run cannot use.
 *
 * @returns {Array<[string, string]>} raw (not yet encoded) pairs
 */
function resolveQueryPairs(query, runState) {
    if (query === undefined || query === null) return [];
    if (!isObj(query)) throw queryError('the setting is not an object with a mode and its values.');
    const mode = query.mode === undefined ? 'fields' : query.mode;
    if (!QUERY_MODES.includes(mode)) throw queryError(`the mode "${String(mode)}" is unknown, use "fields" or "json".`);
    const format = ARRAY_FORMATS.includes(query.arrayFormat) ? query.arrayFormat : 'indices';
    const asData = { listAs: 'json' };
    let pairs;

    if (mode === 'json') {
        const source = typeof query.json === 'string' ? query.json : '';
        if (!source.trim()) return [];
        const text = interpolateJsonBody(source, runState, { field: 'query.json' });
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { throw queryError(jsonProblem(e)); }
        if (!isObj(parsed)) throw queryError('the JSON must be an object such as {"page": 1}.');
        pairs = pairsOfObject(parsed, format);
    } else {
        const items = Array.isArray(query.items) ? query.items : [];
        pairs = [];
        items.forEach((item, i) => {
            if (!isObj(item)) throw queryError(`row ${i + 1} is not a key with a value.`);
            const key = interpolateTemplate(typeof item.key === 'string' ? item.key : '', runState, { ...asData, field: `query.items[${i}].key` }).trim();
            if (!key) return;
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- SOLE_PLACEHOLDER_RE is anchored with one lazy group over [^{}], linear in the value
            const raw = typeof item.value === 'string' ? item.value : (item.value == null ? '' : String(item.value));
            // A value that is exactly one placeholder keeps the type of what it
            // points at, so a list is written in the chosen array format instead
            // of as JSON text.
            const sole = SOLE_PLACEHOLDER_RE.exec(raw);
            const typed = sole ? resolveValue({ kind: 'ref', path: sole[1] }, runState, { allowSecrets: true }) : undefined;
            if (typed !== undefined && (Array.isArray(typed) || isObj(typed))) {
                flatten(key, typed, format, pairs);
            } else {
                const value = typed !== undefined && typed !== null
                    ? String(typed)
                    : interpolateTemplate(raw, runState, { ...asData, field: `query.items[${i}].value` });
                if (!isEmpty(value)) pairs.push([key, value]);
            }
        });
    }
    if (pairs.length > MAX_PAIRS) throw queryError(`there are ${pairs.length} parameters, more than the ${MAX_PAIRS} allowed.`);
    return pairs;
}

/** The part of an encoded query key before its first bracket, decoded: `builder%5B0%5D` → `builder`. */
function rootKeyOf(rawKey) {
    let k = rawKey;
    try { k = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch { /* keep the raw text */ }
    const i = k.indexOf('[');
    return i > 0 ? k.slice(0, i) : k;
}

/**
 * Add the step's parameters to a URL. A query already in the URL stays exactly
 * as written (never decoded and re-encoded, which is how a hand-encoded `%5B`
 * would turn into `%255B`), except for entries whose root key the step also
 * sets: the step wins.
 */
function applyQueryToUrl(url, pairs) {
    if (!pairs.length) return url;
    const hashAt = url.indexOf('#');
    const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
    const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const qAt = noHash.indexOf('?');
    const base = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
    const existing = qAt >= 0 ? noHash.slice(qAt + 1) : '';
    const stepRoots = new Set(pairs.map(([k]) => {
        const i = k.indexOf('[');
        return i > 0 ? k.slice(0, i) : k;
    }));
    const kept = existing.split('&').filter((part) => {
        if (!part) return false;
        const eq = part.indexOf('=');
        return !stepRoots.has(rootKeyOf(eq >= 0 ? part.slice(0, eq) : part));
    });
    const query = [...kept, encodePairs(pairs)].join('&');
    return `${base}?${query}${fragment}`;
}

/**
 * Pull a query out of a URL as the structured form the editor and the builder
 * use: bracket keys become nested JSON (`a[0][b]=c` → {a:[{b:'c'}]}). Returns
 * null when the URL has no query. Repeated plain keys become a list.
 *
 * @returns {{ url: string, query: { mode: 'json', json: string, arrayFormat: string } } | null}
 */
function splitQueryFromUrl(url) {
    const text = String(url || '');
    const hashAt = text.indexOf('#');
    const fragment = hashAt >= 0 ? text.slice(hashAt) : '';
    const noHash = hashAt >= 0 ? text.slice(0, hashAt) : text;
    const qAt = noHash.indexOf('?');
    if (qAt < 0 || qAt === noHash.length - 1) return null;
    const base = noHash.slice(0, qAt);
    const root = {};
    let format = 'indices';
    for (const part of noHash.slice(qAt + 1).split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
        const key = dec(eq >= 0 ? part.slice(0, eq) : part);
        const value = eq >= 0 ? dec(part.slice(eq + 1)) : '';
        const path = [];
        const head = key.split('[')[0];
        path.push(head);
        for (const m of key.slice(head.length).matchAll(/\[([^\]]*)\]/g)) path.push(m[1]);
        // Any empty bracket (`t[]`, `a[][b]`) means the URL lists without indices.
        if (path.slice(1).some(p => p === '')) format = 'brackets';
        assign(root, path, value);
    }
    // A bare `a[]=1&a[]=2` ends in the list's own bracket; keep the rest as written.
    const json = JSON.stringify(root, null, 2);
    return { url: base + fragment, query: { mode: 'json', json, arrayFormat: format } };
}

function assign(root, path, value) {
    let node = root;
    for (let i = 0; i < path.length; i++) {
        const seg = path[i];
        const last = i === path.length - 1;
        const nextIsIndex = !last && /^\d+$/.test(path[i + 1]);
        const nextIsPush = !last && path[i + 1] === '';
        const key = seg === '' ? (Array.isArray(node) ? node.length : seg) : seg;
        if (last) {
            if (Array.isArray(node)) {
                if (seg === '') node.push(value); else node[Number(seg)] = value;
            } else if (Object.prototype.hasOwnProperty.call(node, key)) {
                node[key] = [].concat(node[key], value);
            } else {
                node[key] = value;
            }
            return;
        }
        if (node[key] === undefined || typeof node[key] !== 'object') node[key] = (nextIsIndex || nextIsPush) ? [] : {};
        node = node[key];
    }
}

/**
 * The stored shape of a `query` a caller (the AI builder, an import) handed
 * over, or undefined when there is nothing to store. Rebuilt, never merged: only
 * the keys the runtime reads survive. A plain object without a mode is taken
 * as a JSON-mode query.
 */
function normalizeQuery(value) {
    if (value === undefined || value === null || value === false) return undefined;
    const withFormat = (q, raw) => (ARRAY_FORMATS.includes(raw && raw.arrayFormat) && raw.arrayFormat !== 'indices'
        ? { ...q, arrayFormat: raw.arrayFormat } : q);
    if (typeof value === 'string') return value.trim() ? { mode: 'json', json: value } : undefined;
    if (!isObj(value)) return undefined;
    const hasMode = value.mode === 'fields' || value.mode === 'json';
    if (value.mode === 'fields' || (!hasMode && Array.isArray(value.items))) {
        const items = (Array.isArray(value.items) ? value.items : [])
            .filter((it) => isObj(it) && typeof it.key === 'string' && it.key.trim())
            .map((it) => ({ key: it.key.trim(), value: it.value == null ? '' : (typeof it.value === 'string' ? it.value : String(it.value)) }));
        return items.length ? withFormat({ mode: 'fields', items }, value) : undefined;
    }
    if (value.mode === 'json' || (!hasMode && value.json !== undefined)) {
        const json = isObj(value.json) || Array.isArray(value.json) ? JSON.stringify(value.json) : value.json;
        return typeof json === 'string' && json.trim() ? withFormat({ mode: 'json', json }, value) : undefined;
    }
    // A bare map of parameters: {"page": 1, "builder": [...]}
    return Object.keys(value).length ? { mode: 'json', json: JSON.stringify(value) } : undefined;
}

/** True when the URL's query holds bracket (nested) keys, written plain or percent-encoded. */
function urlHasBracketQuery(url) {
    const text = String(url || '');
    const qAt = text.indexOf('?');
    return qAt >= 0 && /(\[|%5B)/i.test(text.slice(qAt));
}

// The step's final URL: the resolved `url` plus its structured query. A step
// without `query` keeps its URL byte for byte.
function withStepQuery(baseUrl, query, runState) {
    return query ? applyQueryToUrl(baseUrl, resolveQueryPairs(query, runState)) : baseUrl;
}

// Parse the final URL, or fail with a message that names the URL setting
// without echoing the URL itself (it may carry a token in its query).
function parseStepUrl(url) {
    try { return new URL(url); }
    catch (e) {
        const err = new Error(`http_request: invalid URL: not a valid web address (${e.message}). Check the URL setting and any value inserted into it.`);
        err.stepErrorCode = 'http_url_invalid';
        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- a sentence shown to the user, not a credential
        err.userReason = 'it is not a valid web address. Check the URL and any value inserted into it (a domain or path that came out empty is a common cause).';
        throw err;
    }
}

// The Privacy Shield scans what a request CARRIES (path, query, body,
// headers), not where it GOES: the host is the destination the author chose,
// and it is logged as such. Handing the whole URL to the Shield let an
// organisation-name detection turn "ondernemerskompas.inserve.nl" into
// "[organization_1].inserve.nl", and every call then failed with a bare
// "Invalid URL" that named neither the Shield nor the setting.
function splitUrl(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const tail = u.pathname + u.search + u.hash;
    return { base: u.href.slice(0, u.href.length - tail.length), tail };
}

/** The part of a URL the Shield scans: path, query and fragment. */
function shieldPart(url) {
    const parts = splitUrl(url);
    return parts ? parts.tail : url;
}

/** Re-attach the scanned part to the untouched scheme, credentials and host. */
function joinShieldedUrl(url, guarded) {
    if (typeof guarded !== 'string') return url;
    const parts = splitUrl(url);
    if (!parts) return guarded;
    const joined = parts.base + guarded;
    try { new URL(joined); return joined; }
    catch {
        const err = new Error('http_request: the Privacy Shield replaced part of the address, and the result is not a valid web address.');
        err.stepErrorCode = 'http_url_invalid';
        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- a sentence shown to the user, not a credential
        err.userReason = 'the Privacy Shield replaced personal data in the address with a placeholder. Keep personal data out of the URL, or adjust the Privacy Shield for this organisation.';
        throw err;
    }
}

module.exports = {
    shieldPart,
    joinShieldedUrl,
    withStepQuery,
    parseStepUrl,
    normalizeQuery,
    urlHasBracketQuery,
    ARRAY_FORMATS,
    QUERY_MODES,
    resolveQueryPairs,
    applyQueryToUrl,
    encodePairs,
    splitQueryFromUrl,
    queryError,
    _test: { flatten, pairsOfObject, rootKeyOf, jsonProblem },
};
