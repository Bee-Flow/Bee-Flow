/**
 * nmbrsTransport.mts: the one way the NMBRS integration talks to Nmbrs.
 *
 * Every NMBRS request (SOAP, REST and the OAuth token / revocation calls) goes
 * through `nmbrsFetch`, which uses the SSRF-guarded `safeFetch`
 * (utils/ssrfGuard.js), refuses redirects (credentials must never follow a
 * redirect off the pinned host) and bounds every call with a timeout.
 *
 * Errors are mapped to short, leak-free messages: never the raw body, the URL
 * or a credential, only Nmbrs' own human-readable message, sanitised and cut.
 *
 * `nmbrsTransport.fetch` is the seam tests replace; production code never does.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { safeFetch } = nodeRequire('../utils/ssrfGuard.js') as {
    safeFetch: (url: string, init?: Record<string, unknown>) => Promise<NmbrsResponse>;
};
const { fallback } = nodeRequire('../utils/bestEffort.js') as {
    fallback: <T>(label: string, err: unknown, value?: T) => T;
};

/** The part of a fetch Response this integration reads. */
export interface NmbrsResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}

export interface NmbrsRequestInit {
    method?: string;
    headers: Record<string, string>;
    body?: string | null;
}

export type NmbrsFetch = (url: string, init: Record<string, unknown>) => Promise<NmbrsResponse>;

/** The transport. Tests swap `fetch`; nothing else should. */
export const nmbrsTransport: { fetch: NmbrsFetch } = {
    fetch: (url, init) => safeFetch(url, init),
};

export const REQUEST_TIMEOUT_MS = 20000;
const MAX_ERROR_MESSAGE_CHARS = 300;

/** One request with a timeout and no redirects. */
export async function nmbrsFetch(url: string, { method = 'GET', headers, body = null }: NmbrsRequestInit): Promise<NmbrsResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();
    try {
        return await nmbrsTransport.fetch(url, {
            method,
            headers,
            body,
            // Credentials must never follow a redirect off the pinned host.
            redirect: 'error',
            signal: controller.signal,
        });
    } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
            throw new Error(`NMBRS request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
        }
        throw new Error('Could not reach NMBRS. Check the connection settings.');
    } finally {
        clearTimeout(timeout);
    }
}

/** The body as text, or '' when it cannot be read. */
export async function safeText(response: NmbrsResponse): Promise<string> {
    try { return await response.text(); } catch { return ''; }
}

/** Tags off, whitespace folded, cut to the error budget; null when nothing is left. */
function cleanMessage(raw: unknown): string | null {
    return String(raw).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS) || null;
}

/** A JSON error body's message: REST problem details (RFC 7807 `detail` / `title`) or `message`. */
function jsonErrorMessage(bodyText: string): unknown {
    try {
        const data = JSON.parse(bodyText) as Record<string, unknown> & { error?: { message?: unknown } };
        return data.message || data.detail || data.title || (data.error && data.error.message) || null;
    } catch (err) {
        return fallback('integrations/nmbrsTransport:jsonErrorMessage', err, null);
    }
}

/**
 * A short, sanitised error message from a NMBRS error body. Only a human-readable
 * message: never the raw body, URL or credentials.
 */
export function extractNmbrsErrorMessage(bodyText: unknown): string | null {
    if (!bodyText || typeof bodyText !== 'string') return null;
    const soap = bodyText.match(/<faultstring>([\s\S]*?)<\/faultstring>/i)
        || bodyText.match(/<Message>([\s\S]*?)<\/Message>/i);
    let message: unknown = null;
    if (soap) message = soap[1];
    else if (bodyText.trim().startsWith('{')) message = jsonErrorMessage(bodyText);
    return message ? cleanMessage(message) : null;
}

const STATUS_REASONS: Record<number, string> = {
    400: 'NMBRS rejected the request (check the IDs and parameters)',
    401: 'NMBRS credentials are invalid or the token was revoked',
    403: 'this NMBRS account lacks rights to that data',
    404: 'the requested NMBRS record was not found',
    429: 'NMBRS rate limit reached — try again shortly',
    500: 'NMBRS returned a server error',
};

/** An Error for an HTTP failure: the mapped reason plus Nmbrs' own short message. */
export function mapNmbrsError(status: number, bodyText: string): Error {
    const reason = STATUS_REASONS[status] || `NMBRS returned HTTP ${status}`;
    const detail = extractNmbrsErrorMessage(bodyText);
    return new Error(detail ? `${reason}: ${detail}` : reason);
}

/** A sanitised SOAP fault text, for the SOAP result reader. */
export function soapFaultMessage(raw: unknown): string {
    return cleanMessage(raw) || 'SOAP fault';
}
