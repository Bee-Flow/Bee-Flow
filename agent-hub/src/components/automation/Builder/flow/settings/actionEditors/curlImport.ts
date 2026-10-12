/**
 * "Import cURL" for the http_request editor: turns a pasted curl command into
 * the fields of the step. Pure and dependency free; the pasted text is never
 * logged and secrets in it are never copied into the step: the caller gets
 * their NAMES back (`skipped`) so the user can pick a saved credential instead.
 */
import { splitQueryFromUrl, type HttpQuery } from './httpQueryLib';

export type CurlSkipped = { kind: 'header' | 'basic_auth' | 'cookie' | 'url_credentials' | 'query'; name: string };

export type CurlImport = {
    method: string;
    /** The URL without its query string. */
    url: string;
    query: HttpQuery | null;
    headers: Record<string, string>;
    body: string;
    skipped: CurlSkipped[];
    /** Short codes the dialog words: 'multipart', 'no_url'. */
    warnings: string[];
};

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|api[-_]?key|token|secret|password|passwd|credential|signature|session/i;
const SECRET_QUERY = /api[-_]?key|token|secret|passw(or)?d|signature|credential|access[-_]?key|^auth$|^key$|^sig$/i;

export const isSecretHeader = (name: string) => SECRET_HEADER.test(name.trim());

/** Split a shell-ish command into words: quotes, $'…', backslash escapes and line continuations. */
export function tokenize(input: string): string[] {
    const text = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
    const out: string[] = [];
    let cur = '';
    let active = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'") {
            const end = text.indexOf("'", i + 1);
            const stop = end < 0 ? text.length : end;
            cur += text.slice(i + 1, stop);
            i = stop; active = true;
        } else if (ch === '$' && text[i + 1] === "'") {
            let j = i + 2;
            while (j < text.length && text[j] !== "'") {
                if (text[j] === '\\' && j + 1 < text.length) {
                    const n = text[++j];
                    cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
                } else cur += text[j];
                j++;
            }
            i = j; active = true;
        } else if (ch === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') {
                if (text[j] === '\\' && j + 1 < text.length && '"\\$`'.includes(text[j + 1])) j++;
                cur += text[j];
                j++;
            }
            i = j; active = true;
        } else if (ch === '\\' && i + 1 < text.length) {
            cur += text[++i]; active = true;
        } else if (/\s/.test(ch)) {
            if (active) { out.push(cur); cur = ''; active = false; }
        } else { cur += ch; active = true; }
    }
    if (active) out.push(cur);
    return out;
}

const LONG_WITH_VALUE = new Set([
    'request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'form', 'form-string',
    'user', 'url', 'cookie', 'user-agent', 'referer', 'json',
]);
const SHORT_WITH_VALUE = new Set(['X', 'H', 'd', 'F', 'u', 'b', 'A', 'e']);
const SHORT_TO_LONG: Record<string, string> = { X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', b: 'cookie', A: 'user-agent', e: 'referer' };

function encodeFormPart(spec: string): string {
    const eq = spec.indexOf('=');
    if (eq < 0) return encodeURIComponent(spec);
    return `${spec.slice(0, eq) ? `${spec.slice(0, eq)}=` : ''}${encodeURIComponent(spec.slice(eq + 1))}`;
}


export function parseCurl(input: string): CurlImport | null {
    const tokens = tokenize(input.trim());
    if (!tokens.length) return null;
    if (tokens[0].toLowerCase() === 'curl') tokens.shift();

    let method = '';
    let url = '';
    let getMode = false;
    let head = false;
    let multipart = false;
    const data: string[] = [];
    const headers: Record<string, string> = {};
    const skipped: CurlSkipped[] = [];
    const warnings: string[] = [];
    let json = false;

    const take = (long: string, value: string) => {
        switch (long) {
            case 'request': method = value.toUpperCase(); break;
            case 'url': url = value; break;
            case 'header': {
                const c = value.indexOf(':');
                if (c <= 0) break;
                const name = value.slice(0, c).trim();
                const val = value.slice(c + 1).trim();
                if (isSecretHeader(name)) skipped.push({ kind: 'header', name });
                else headers[name] = val;
                break;
            }
            case 'data': case 'data-raw': case 'data-binary': case 'data-ascii': data.push(value); break;
            case 'json': data.push(value); json = true; break;
            case 'data-urlencode': data.push(encodeFormPart(value)); break;
            case 'form': case 'form-string': multipart = true; break;
            case 'user': skipped.push({ kind: 'basic_auth', name: '-u (user:password)' }); break;
            case 'cookie': skipped.push({ kind: 'cookie', name: 'Cookie' }); break;
            case 'user-agent': headers['User-Agent'] = value; break;
            case 'referer': headers.Referer = value; break;
        }
    };

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.startsWith('--')) {
            const eq = tok.indexOf('=');
            const name = tok.slice(2, eq > 0 ? eq : undefined);
            if (name === 'get') getMode = true;
            else if (name === 'head') head = true;
            else if (LONG_WITH_VALUE.has(name)) take(name, eq > 0 ? tok.slice(eq + 1) : (tokens[++i] ?? ''));
        } else if (tok.startsWith('-') && tok.length > 1) {
            for (let k = 1; k < tok.length; k++) {
                const c = tok[k];
                if (SHORT_WITH_VALUE.has(c)) {
                    const rest = tok.slice(k + 1);
                    take(SHORT_TO_LONG[c], rest || (tokens[++i] ?? ''));
                    break;
                }
                if (c === 'G') getMode = true;
                else if (c === 'I') head = true;
            }
        } else if (!url) url = tok;
    }

    if (!url) return null;
    if (multipart) warnings.push('multipart');
    if (json) {
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers.Accept = 'application/json';
    }

    let body = getMode ? '' : data.join('&');
    if (getMode && data.length) url += `${url.includes('?') ? '&' : '?'}${data.join('&')}`;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;

    // user:password@host: the credentials are dropped from the address.
    const cred = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i.exec(url);
    if (cred) {
        url = cred[1] + url.slice(cred[0].length);
        skipped.push({ kind: 'url_credentials', name: 'user:password@' });
    }

    if (!method) method = head ? 'HEAD' : getMode ? 'GET' : (body || multipart) ? 'POST' : 'GET';
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) method = 'GET';


    // Query: out of the URL into the structured query, secrets in it left out.
    let query: HttpQuery | null = null;
    const split = splitQueryFromUrl(url);
    if (split) {
        url = split.url;
        const root = JSON.parse(split.query.json || '{}') as Record<string, unknown>;
        for (const key of Object.keys(root)) {
            if (SECRET_QUERY.test(key)) { skipped.push({ kind: 'query', name: key }); delete root[key]; }
        }
        const entries = Object.entries(root);
        if (entries.length) {
            query = entries.every(([, v]) => typeof v === 'string')
                ? { mode: 'fields', items: entries.map(([key, value]) => ({ key, value: value as string })) }
                : { ...split.query, json: JSON.stringify(root, null, 2) };
        }
    }
    return { method, url, query, headers, body, skipped, warnings };
}
