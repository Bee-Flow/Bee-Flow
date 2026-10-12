/**
 * Client side of an http_request step's `query`: the preview of the final URL
 * and the "move the query out of the URL" action. The runtime serialiser is
 * server/core/automationRunner/httpQuery.js (agent-hub cannot import from
 * server/); this port keeps the same rules so the preview matches the run.
 * Bindings ({{…}}) are not resolved here: they stay visible as {{…}}.
 */

export type ArrayFormat = 'indices' | 'brackets' | 'repeat' | 'comma';
export type QueryRow = { key: string; value: string };
export type HttpQuery = {
    mode: 'fields' | 'json';
    items?: QueryRow[];
    json?: string;
    arrayFormat?: ArrayFormat;
};

export const ARRAY_FORMATS: ArrayFormat[] = ['indices', 'brackets', 'repeat', 'comma'];

type Pair = [string, string];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v: unknown) => v === undefined || v === null || v === '';
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof v);

function flatten(prefix: string, value: unknown, format: ArrayFormat, out: Pair[]): void {
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
    out.push([prefix, String(value)]);
}

// A plain-text token: JSON.parse refuses raw control characters inside a
// string, so a token built from \u0001/\u0002 made every query with a binding
// read as invalid JSON (and the preview dropped the whole query).
const TOKEN_OPEN = '__bf_binding_';
const TOKEN_CLOSE = '__';
const BINDING_RE = /\{\{[^{}]*\}\}/g;

/** Parse JSON text that holds {{bindings}}: a bare one becomes a placeholder string. Null when invalid. */
export function parseJsonWithBindings(source: string): { value: unknown; bindings: string[] } | null {
    const bindings: string[] = [];
    let out = '';
    let inString = false;
    for (let i = 0; i < source.length; ) {
        const rest = source.slice(i);
        const m = rest.startsWith('{{') ? /^\{\{[^{}]*\}\}/.exec(rest) : null;
        if (m) {
            bindings.push(m[0]);
            const token = `${TOKEN_OPEN}${bindings.length - 1}${TOKEN_CLOSE}`;
            out += inString ? token : `"${token}"`;
            i += m[0].length;
            continue;
        }
        const ch = source[i];
        if (ch === '\\' && inString) { out += ch + (source[i + 1] ?? ''); i += 2; continue; }
        if (ch === '"') inString = !inString;
        out += ch;
        i += 1;
    }
    try { return { value: JSON.parse(out), bindings }; } catch { return null; }
}

const restore = (text: string, bindings: string[]) =>
    text.replace(new RegExp(`${TOKEN_OPEN}(\\d+)${TOKEN_CLOSE}`, 'g'), (_m, n) => bindings[Number(n)] ?? '');

/** The raw [key, value] pairs of a query, or an error key for the editor. */
export function queryPairs(query: HttpQuery | null | undefined): { pairs: Pair[]; error: 'json' | 'not_object' | null } {
    if (!query) return { pairs: [], error: null };
    const format = ARRAY_FORMATS.includes(query.arrayFormat as ArrayFormat) ? (query.arrayFormat as ArrayFormat) : 'indices';
    const pairs: Pair[] = [];
    if (query.mode === 'json') {
        const source = query.json || '';
        if (!source.trim()) return { pairs, error: null };
        const parsed = parseJsonWithBindings(source);
        if (!parsed) return { pairs, error: 'json' };
        if (!isObj(parsed.value)) return { pairs, error: 'not_object' };
        for (const [k, v] of Object.entries(parsed.value)) flatten(k, v, format, pairs);
        return { pairs: pairs.map(([k, v]) => [restore(k, parsed.bindings), restore(v, parsed.bindings)] as Pair), error: null };
    }
    for (const row of query.items || []) {
        const key = (row.key || '').trim();
        if (key && !isEmpty(row.value)) pairs.push([key, row.value]);
    }
    return { pairs, error: null };
}

/** Percent-encode like the runtime, but leave {{…}} readable in the preview. */
function encodePreview(text: string): string {
    return text.split(/(\{\{[^{}]*\}\})/).map((part) => (part.startsWith('{{') ? part : encodeURIComponent(part))).join('');
}

const rootOf = (k: string) => { const i = k.indexOf('['); return i > 0 ? k.slice(0, i) : k; };
const decode = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

/** The URL as the run will send it (bindings unresolved), same merge rules as the runtime. */
export function previewUrl(url: string, query: HttpQuery | null | undefined): string {
    const { pairs } = queryPairs(query);
    if (!pairs.length) return url;
    const hashAt = url.indexOf('#');
    const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
    const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const qAt = noHash.indexOf('?');
    const base = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
    const existing = qAt >= 0 ? noHash.slice(qAt + 1) : '';
    const roots = new Set(pairs.map(([k]) => rootOf(k)));
    const kept = existing.split('&').filter((part) => {
        if (!part) return false;
        const eq = part.indexOf('=');
        return !roots.has(rootOf(decode(eq >= 0 ? part.slice(0, eq) : part)));
    });
    const mine = pairs.map(([k, v]) => `${encodePreview(k)}=${encodePreview(v)}`).join('&');
    return `${base}?${[...kept, mine].join('&')}${fragment}`;
}

function assign(root: Record<string, unknown>, path: string[], value: string): void {
    let node: any = root;
    for (let i = 0; i < path.length; i++) {
        const seg = path[i];
        const last = i === path.length - 1;
        const nextIsIndex = !last && /^\d+$/.test(path[i + 1]);
        const nextIsPush = !last && path[i + 1] === '';
        const key = seg === '' ? (Array.isArray(node) ? node.length : seg) : seg;
        if (last) {
            if (Array.isArray(node)) { if (seg === '') node.push(value); else node[Number(seg)] = value; }
            else if (Object.prototype.hasOwnProperty.call(node, key)) node[key] = ([] as unknown[]).concat(node[key], value);
            else node[key] = value;
            return;
        }
        if (node[key] === undefined || typeof node[key] !== 'object') node[key] = (nextIsIndex || nextIsPush) ? [] : {};
        node = node[key];
    }
}

/**
 * Take the query out of a URL as nested JSON (`a[0][b]=c` becomes {a:[{b:"c"}]}).
 * Null when the URL has no query.
 */
export function splitQueryFromUrl(url: string): { url: string; query: HttpQuery } | null {
    const hashAt = url.indexOf('#');
    const fragment = hashAt >= 0 ? url.slice(hashAt) : '';
    const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const qAt = noHash.indexOf('?');
    if (qAt < 0 || qAt === noHash.length - 1) return null;
    const root: Record<string, unknown> = {};
    let format: ArrayFormat = 'indices';
    for (const part of noHash.slice(qAt + 1).split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const key = decode(eq >= 0 ? part.slice(0, eq) : part);
        const value = eq >= 0 ? decode(part.slice(eq + 1)) : '';
        const head = key.split('[')[0];
        const path = [head];
        for (const m of key.slice(head.length).matchAll(/\[([^\]]*)\]/g)) path.push(m[1]);
        // Any empty bracket (`t[]`, `a[][b]`) means the URL lists without indices.
        if (path.slice(1).some((p) => p === '')) format = 'brackets';
        assign(root, path, value);
    }
    return { url: noHash.slice(0, qAt) + fragment, query: { mode: 'json', json: JSON.stringify(root, null, 2), arrayFormat: format } };
}

/**
 * The new query when the URL's own query is moved in. An existing JSON query
 * keeps its keys over the URL's; an existing rows query gets one row per
 * top-level key of the URL's query (nested ones as JSON text in a JSON query
 * instead: this keeps rows simple and never loses data). Null when the existing
 * JSON text cannot be merged without losing something.
 */
export function mergeMovedQuery(existing: HttpQuery | null | undefined, moved: HttpQuery): HttpQuery | null {
    const hasRows = existing?.mode === 'fields' && (existing.items || []).some((r) => r.key.trim());
    const hasJson = existing?.mode === 'json' && !!existing.json?.trim();
    if (!hasRows && !hasJson) return moved;
    const movedObj = JSON.parse(moved.json || '{}') as Record<string, unknown>;
    if (hasJson) {
        const parsed = parseJsonWithBindings(existing!.json || '');
        // JSON text with bindings (or broken text) cannot be rewritten without
        // losing something: the caller then leaves the URL alone.
        if (!parsed || !isObj(parsed.value) || parsed.bindings.length) return null;
        return { ...existing!, mode: 'json', json: JSON.stringify({ ...movedObj, ...(parsed.value as object) }, null, 2) };
    }
    const flat: Pair[] = [];
    for (const [k, v] of Object.entries(movedObj)) flatten(k, v, moved.arrayFormat || 'indices', flat);
    const taken = new Set((existing!.items || []).map((r) => r.key.trim()));
    return { ...existing!, mode: 'fields', items: [...flat.filter(([k]) => !taken.has(k)).map(([key, value]) => ({ key, value })), ...(existing!.items || [])] };
}
