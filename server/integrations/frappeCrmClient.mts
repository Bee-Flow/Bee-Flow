/**
 * Transport for the Frappe CRM integration: one REST request against a Frappe
 * site (Frappe Cloud or self-hosted), through the hardened choke point
 * integrations/shared/apiClient.js (SSRF guard, timeout, no URL in errors).
 *
 * Auth is Frappe's token header, `Authorization: token <api_key>:<api_secret>`,
 * from the per-user connection (`frappe_crm_*_user_<id>`, stored sealed by
 * configStore.setSecret). The site address is checked by frappeCrmHost.mts on
 * every call, so a value stored before a policy change is checked again.
 *
 * Errors come back as one short sentence: the HTTP status, and for a
 * validation error Frappe's own message, truncated, with the key and the
 * secret scrubbed. Nothing in this module logs; the caller logs the tool name
 * and the status only, never record content.
 */

import { createRequire } from 'node:module';
import { checkSiteUrl, assertNotLinkLocal } from './frappeCrmHost.mts';

const nodeRequire = createRequire(import.meta.url);
const { jsonApiRequest } = nodeRequire('./shared/apiClient.js') as {
    jsonApiRequest: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
};
const configStore = nodeRequire('../stores/configStore.js') as {
    getSecret: (key: string) => Promise<string | null | undefined>;
};

export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_CHARS = 300;
// Large enough to parse Frappe's JSON error body; never shown or logged as is.
const MAX_ERROR_BODY_CHARS = 20_000;
const MAX_CREDENTIAL_CHARS = 256;

export interface FrappeCreds {
    url: string;
    apiKey: string;
    apiSecret: string;
}

/** A non-negative integer from the environment; unset or malformed gives the fallback. */
export function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Request timeout in ms (FRAPPE_CRM_TIMEOUT_MS; 0 falls back to the default). */
export function getTimeoutMs(): number {
    return envInt('FRAPPE_CRM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
}

/**
 * An API key or secret: 1-256 printable ASCII characters without spaces. It
 * travels in a header, so this is the header-injection guard; the key may not
 * hold the ':' that separates it from the secret.
 */
export function isValidCredential(value: unknown, { allowColon = true } = {}): boolean {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CREDENTIAL_CHARS) return false;
    for (let i = 0; i < value.length; i += 1) {
        const c = value.charCodeAt(i);
        if (c <= 0x20 || c >= 0x7f) return false;
        if (!allowColon && c === 0x3a) return false;
    }
    return true;
}

/** Throws an Error naming the bad field; the normalised connection otherwise. */
export function assertValidCredentials(raw: { url?: unknown; apiKey?: unknown; apiSecret?: unknown }): FrappeCreds {
    const url = String(raw.url ?? '').trim();
    const apiKey = String(raw.apiKey ?? '').trim();
    const apiSecret = String(raw.apiSecret ?? '').trim();
    checkSiteUrl(url);
    if (!isValidCredential(apiKey, { allowColon: false })) throw new Error('The Frappe CRM API key has an invalid format. Paste the key from User > API Access, with no spaces.');
    if (!isValidCredential(apiSecret)) throw new Error('The Frappe CRM API secret has an invalid format. Paste the secret shown when the key was generated, with no spaces.');
    return { url, apiKey, apiSecret };
}

/** The stored connection of a user, or null when a part is missing (not validated here). */
export async function getFrappeCrmCredentials(userId: string): Promise<FrappeCreds | null> {
    const read = async (field: string) => {
        const value = await configStore.getSecret(`frappe_crm_${field}_user_${userId}`);
        return value === null || value === undefined ? '' : String(value).trim();
    };
    const url = await read('url');
    const apiKey = await read('api_key');
    const apiSecret = await read('api_secret');
    if (!url || !apiKey || !apiSecret) return null;
    return { url, apiKey, apiSecret };
}

// ─── Errors ────────────────────────────────────────────────────

/** `text` without the key and the secret. */
function scrub(text: string, creds: FrappeCreds): string {
    let out = text;
    for (const s of [creds.apiSecret, creds.apiKey]) {
        if (s) out = out.split(s).join('***');
    }
    return out;
}

/** Remove markup from a Frappe message (it often holds <b> and <br>). */
function stripTags(text: string): string {
    let out = '';
    let inTag = false;
    for (const ch of text) {
        if (ch === '<') inTag = true;
        else if (ch === '>' && inTag) { inTag = false; out += ' '; }
        else if (!inTag) out += ch;
    }
    return out.split(/\s+/).join(' ').trim();
}

/** Frappe's own message from an error body: `_server_messages`, else the last line of `exception`. */
export function frappeServerMessage(body: string): string {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return ''; }
    if (!parsed || typeof parsed !== 'object') return '';
    const obj = parsed as { _server_messages?: unknown; exception?: unknown; message?: unknown };
    if (typeof obj._server_messages === 'string') {
        try {
            const list = JSON.parse(obj._server_messages) as unknown[];
            const messages = (Array.isArray(list) ? list : []).map((entry) => {
                try {
                    const m = typeof entry === 'string' ? JSON.parse(entry) as { message?: unknown } : entry as { message?: unknown };
                    return typeof m?.message === 'string' ? m.message : '';
                } catch {
                    return typeof entry === 'string' ? entry : '';
                }
            }).filter(Boolean);
            if (messages.length) return stripTags(messages.join(' '));
        } catch { /* not the documented shape: fall through to exception */ }
    }
    if (typeof obj.exception === 'string' && obj.exception) {
        const line = obj.exception.trim().split('\n').pop() || '';
        const colon = line.indexOf(': ');
        return stripTags(colon >= 0 ? line.slice(colon + 2) : line);
    }
    if (typeof obj.message === 'string') return stripTags(obj.message);
    return '';
}

const STATUS_TEXT: Record<number, string> = {
    401: 'the API key and secret were refused (HTTP 401). Check them under User > API Access.',
    403: 'the API user is not permitted to do this (HTTP 403). Give that user a CRM role with access to this record type.',
    404: 'not found (HTTP 404). Check the record name, or that this site runs Frappe CRM.',
    429: 'too many requests (HTTP 429). Try again later.',
};

export class FrappeCrmError extends Error {
    /** The HTTP status Frappe answered with; undefined when no answer came. */
    status?: number;
    /** True when the message carries text the site itself answered with. */
    fromSite?: boolean;
    constructor(message: string, status?: number) {
        super(message);
        this.name = 'FrappeCrmError';
        if (status !== undefined) this.status = status;
    }
}

/** The error a request failed with, as a sentence that is safe to show. */
export function mapFrappeError(err: unknown, creds: FrappeCreds): FrappeCrmError {
    if (err instanceof FrappeCrmError) return err;
    const e = (err && typeof err === 'object' ? err : {}) as { message?: unknown; status?: unknown; code?: unknown };
    if (e.code === 'EPRIVATETARGET') return new FrappeCrmError('this site is on a private or blocked address, which this server does not connect to.');
    if (e.code === 'ETIMEDOUT') return new FrappeCrmError('the site did not answer in time.');
    if (e.code === 'EREQUEST') return new FrappeCrmError('the site could not be reached. Check the address.');
    const status = Number(e.status);
    // An unexpected failure: its text may hold anything, so it is not shown.
    if (!Number.isInteger(status) || status <= 0) return new FrappeCrmError('the request failed.');
    if (status >= 300 && status < 400) return new FrappeCrmError(`the site answered with a redirect (HTTP ${status}). Enter the final address of the site, usually starting with https://.`, status);
    if (STATUS_TEXT[status]) return new FrappeCrmError(STATUS_TEXT[status], status);
    const text = String(e.message || '');
    const marker = `HTTP ${status} `;
    const at = text.indexOf(marker);
    const detail = at >= 0 ? frappeServerMessage(text.slice(at + marker.length)) : '';
    let shown = scrub(detail, creds);
    if (shown.length > MAX_MESSAGE_CHARS) shown = `${shown.slice(0, MAX_MESSAGE_CHARS)}…`;
    const mapped = new FrappeCrmError(shown ? `HTTP ${status}: ${shown}` : `the site answered HTTP ${status}.`, status);
    // The site's own words: the tools pass them to the model, the connection test never shows them.
    if (shown) mapped.fromSite = true;
    return mapped;
}

// ─── Request ───────────────────────────────────────────────────

export interface RequestOptions {
    query?: Record<string, string | number | undefined>;
    body?: Record<string, unknown>;
}

/**
 * One request. `path` starts with /api/ and has every variable part already
 * encoded by the caller. Resolves to the parsed JSON (Frappe wraps answers in
 * `{ data }` for /api/resource and `{ message }` for /api/method).
 */
export async function frappeRequest(creds: FrappeCreds, method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    if (!path.startsWith('/api/')) throw new FrappeCrmError('internal: bad path.');
    let target;
    try {
        target = checkSiteUrl(creds.url);
        await assertNotLinkLocal(target);
    } catch (err) {
        // Our own wording about the address (frappeCrmHost.mts): safe to show.
        throw new FrappeCrmError(err instanceof Error ? err.message : 'the address is not valid.');
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.query || {})) {
        if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    const url = `${target.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    try {
        return await jsonApiRequest(url, {
            method,
            headers: { Authorization: `token ${creds.apiKey}:${creds.apiSecret}`, Accept: 'application/json' },
            body: options.body,
            timeoutMs: getTimeoutMs(),
            errorPrefix: 'Frappe CRM API',
            maxErrorChars: MAX_ERROR_BODY_CHARS,
            allowPrivate: target.allowPrivate,
            // The private-mode check above covers the first hop only.
            ...(target.allowPrivate ? { redirect: 'manual' } : {}),
        });
    } catch (err) {
        throw mapFrappeError(err, creds);
    }
}
