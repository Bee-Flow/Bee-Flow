/**
 * The request an http_request step sends, built from values that are already resolved: the
 * address (the connector's own origin plus the step's path and query), the headers the author
 * may set and the encoded body. Pure: no I/O, nothing here reads a credential.
 *
 * The rules that keep the call where the connector's owner pointed it:
 *   - the origin (scheme, host, port) is read from the connector's URL and from nothing else;
 *   - the path starts with one "/", holds no "?", "#", backslash, control character or dot
 *     segment, so it cannot name another host or climb out of what the author wrote;
 *   - a header the connector or its credential sets, and every header that carries identity
 *     or framing, is refused by name.
 */

export type Obj = Record<string, unknown>;
export type Refusal = { ok: false; code: string; error: string };
export type RestConnector = { id?: unknown; kind?: unknown; url?: unknown; headers?: unknown; auth?: unknown };

export const HTTP_METHODS: readonly string[] = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const BODY_FORMATS: readonly string[] = Object.freeze(['json', 'form', 'text']);
export const MAX_URL_CHARS = 8000;
export const MAX_HEADER_NAME_CHARS = 64;
export const MAX_HEADER_VALUE_CHARS = 2000;
export const MAX_QUERY_NAME_CHARS = 100;

/**
 * Headers an author never sets: identity, cookies, message framing, and the headers some
 * services read as the real method (a GET must stay a read, also in a dry run). Lower case.
 */
export const FORBIDDEN_HEADERS: readonly string[] = Object.freeze([
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'content-length', 'transfer-encoding',
    'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'expect', 'idempotency-key',
    'x-http-method-override', 'x-http-method', 'x-method-override',
]);

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
    json: 'application/json', form: 'application/x-www-form-urlencoded', text: 'text/plain; charset=utf-8',
});

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const refuse = (error: string, code = 'http_bad_input'): Refusal => ({ ok: false, code, error });

/** The method a step asks for (GET when it names none or an unknown one is refused by the caller). */
export function methodOf(step: Obj): string {
    return typeof step.method === 'string' && HTTP_METHODS.includes(step.method) ? step.method : 'GET';
}

export const isWrite = (method: string): boolean => method !== 'GET';

const HTTPS = 'https://';

/**
 * scheme://host[:port] of a rest connector's URL template, or null when the template is not
 * https or its authority holds a placeholder. Read from the text before the first "/", "?" or
 * "#", so a placeholder further on can never be taken for part of the host.
 */
export function connectorOrigin(connector: RestConnector | null | undefined): string | null {
    const template = connector && typeof connector.url === 'string' ? connector.url.trim() : '';
    if (template.slice(0, HTTPS.length).toLowerCase() !== HTTPS) return null;
    let end = template.length;
    for (const stop of ['/', '?', '#']) {
        const at = template.indexOf(stop, HTTPS.length);
        if (at >= 0 && at < end) end = at;
    }
    const authority = template.slice(HTTPS.length, end);
    if (!authority || authority.includes('{') || authority.includes('}') || authority.includes('@') || authority.includes('\\')) return null;
    try {
        const url = new URL(`${HTTPS}${authority}`);
        return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
    } catch {
        return null;
    }
}

function hasControlOrSpace(text: string): boolean {
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c <= 0x20 || c === 0x7f) return true;
    }
    return false;
}

function isDotSegment(segment: string): boolean {
    const plain = segment.toLowerCase().split('%2e').join('.');
    return plain === '.' || plain === '..';
}

/** Why `path` is not a path on the connector's host, as a sentence; null when it is one. */
export function pathProblem(path: string): string | null {
    if (path[0] !== '/') return 'The path must start with "/".';
    if (path[1] === '/') return 'The path must start with one "/", not two.';
    if (path.includes('\\')) return 'The path may not hold a backslash.';
    if (path.includes('?') || path.includes('#')) return 'The path may not hold "?" or "#"; put query parameters in `query`.';
    if (hasControlOrSpace(path)) return 'The path may not hold spaces or control characters (write a space as %20).';
    if (path.split('/').some(isDotSegment)) return 'The path may not hold "." or ".." segments.';
    return null;
}

function isHeaderNameChar(c: number): boolean {
    return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;
}

/** Why an author may not set a header of this name; null when they may. */
export function headerNameProblem(name: string): string | null {
    if (!name || name.length > MAX_HEADER_NAME_CHARS) return `A header name has 1 to ${MAX_HEADER_NAME_CHARS} characters.`;
    for (let i = 0; i < name.length; i += 1) {
        if (!isHeaderNameChar(name.charCodeAt(i))) return `The header name ${JSON.stringify(name.slice(0, 80))} may hold only letters, digits, "-" and "_".`;
    }
    if (FORBIDDEN_HEADERS.includes(name.toLowerCase())) return `The header "${name}" is not set by a step (the connection carries the credential, the server the framing).`;
    return null;
}

/** The header names the connector itself sets (its fixed headers and its credential header), lower case. */
export function connectorHeaderNames(connector: RestConnector): string[] {
    const names = isObject(connector.headers) ? Object.keys(connector.headers) : [];
    const auth = isObject(connector.auth) ? connector.auth : null;
    if (auth && auth.type === 'header' && typeof auth.header === 'string') names.push(auth.header);
    return names.map((n) => n.toLowerCase());
}

function headerValue(value: unknown): string | null {
    if (!isScalar(value)) return null;
    const text = String(value);
    if (text.length > MAX_HEADER_VALUE_CHARS) return null;
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if ((c < 0x20 && c !== 0x09) || c === 0x7f || c > 0xff) return null;
    }
    return text;
}

/** The author's headers as text. A header whose value is empty is left out. */
export function authoredHeaders(values: Obj, connector: RestConnector): { ok: true; headers: Record<string, string> } | Refusal {
    const taken = connectorHeaderNames(connector);
    const headers: Record<string, string> = {};
    for (const [name, raw] of Object.entries(values)) {
        const problem = headerNameProblem(name);
        if (problem) return refuse(problem, 'http_header_refused');
        if (taken.includes(name.toLowerCase())) return refuse(`The header "${name}" is set by the connection and cannot be changed by a step.`, 'http_header_refused');
        if (raw === null || raw === undefined || raw === '') continue;
        const text = headerValue(raw);
        if (text === null) return refuse(`The header "${name}" must be a short text, a number or true/false without line breaks.`);
        headers[name] = text;
    }
    return { ok: true, headers };
}

/** The query as [name, text] pairs: a list sends its name once per item, an empty value is left out. */
export function queryPairs(values: Obj): { ok: true; pairs: Array<[string, string]> } | Refusal {
    const pairs: Array<[string, string]> = [];
    for (const [name, raw] of Object.entries(values)) {
        if (!name || name.length > MAX_QUERY_NAME_CHARS) return refuse(`A query parameter name has 1 to ${MAX_QUERY_NAME_CHARS} characters.`);
        for (const value of Array.isArray(raw) ? raw : [raw]) {
            if (value === null || value === undefined || value === '') continue;
            if (!isScalar(value)) return refuse(`The query parameter "${name.slice(0, 80)}" must be a text, a number, true/false or a list of those.`);
            pairs.push([name, String(value)]);
        }
    }
    return { ok: true, pairs };
}

/** The address: the connector's origin, the checked path and the query. Never leaves that origin. */
export function buildUrl(origin: string, path: string, pairs: Array<[string, string]>): { ok: true; url: URL } | Refusal {
    const problem = pathProblem(path);
    if (problem) return refuse(problem, 'http_path_refused');
    let url: URL;
    try { url = new URL(`${origin}${path}`); } catch { return refuse('The path does not make a valid address.', 'http_path_refused'); }
    if (url.origin !== origin || url.search || url.hash) return refuse('The path does not stay on the connection\'s host.', 'http_path_refused');
    for (const [name, value] of pairs) url.searchParams.append(name, value);
    if (url.href.length > MAX_URL_CHARS) return refuse(`The address is longer than ${MAX_URL_CHARS} characters.`);
    return { ok: true, url };
}

export type EncodedBody = { ok: true; text: string | undefined; contentType: string | null } | Refusal;

function formBody(value: unknown): string | null {
    if (!isObject(value)) return null;
    const params = new URLSearchParams();
    for (const [name, raw] of Object.entries(value)) {
        for (const item of Array.isArray(raw) ? raw : [raw]) {
            if (item === null || item === undefined) continue;
            if (!isScalar(item)) return null;
            params.append(name, String(item));
        }
    }
    return params.toString();
}

function jsonBody(value: unknown): string | null {
    // A text is JSON the author (or an earlier step) already wrote: it must parse.
    if (typeof value === 'string') {
        try { return JSON.stringify(JSON.parse(value)); } catch { return null; }
    }
    try { return JSON.stringify(value) ?? null; } catch { return null; }
}

/** The body as it goes on the wire, for a write; nothing for a GET or an empty body. */
export function encodeBody(value: unknown, format: string, method: string): EncodedBody {
    if (!isWrite(method) || value === null || value === undefined) return { ok: true, text: undefined, contentType: null };
    const kind = BODY_FORMATS.includes(format) ? format : 'json';
    let text: string | null;
    if (kind === 'json') text = jsonBody(value);
    else if (kind === 'form') text = formBody(value);
    else text = isScalar(value) ? String(value) : null;
    if (text === null) {
        const want = kind === 'json' ? 'a record, a list or JSON text' : kind === 'form' ? 'a flat record of texts and numbers' : 'a text';
        return refuse(`The body does not fit bodyFormat "${kind}": it must be ${want}.`);
    }
    return { ok: true, text, contentType: CONTENT_TYPES[kind] };
}

function decoded(text: string): string {
    try { return decodeURIComponent(text); } catch { return text; }
}

/** The filled path as the values in it read, segment by segment: what the privacy check looks at. */
export function plainPath(path: string): string {
    return path.split('/').map(decoded).join('/');
}

/** The encoded body as the values in it read: a form body is `name=value` lines, anything else is itself. */
export function plainBody(text: string | undefined, contentType: string | null): string {
    if (text === undefined) return '';
    if (contentType !== CONTENT_TYPES.form) return text;
    return [...new URLSearchParams(text)].map(([name, value]) => `${name}=${value}`).join('\n');
}
