/**
 * twobaTransport.mts: the one way the 2BA integration talks to 2BA.
 *
 * Every request (the API on api.2ba.nl and the OAuth endpoints on
 * authorize.2ba.nl) goes through `twobaFetch`: fixed hosts written here, so the
 * call uses fetchFixedEndpoint (utils/fixedEndpointFetch.mts) with its default
 * time-out (OUTBOUND_HTTP_TIMEOUT_MS), never a URL from a user or a model. A
 * redirect is refused: a bearer token must never follow one off the host.
 *
 * 429 and 503 are retried with back-off: the Retry-After seconds when 2BA
 * sends them, else 0.5 s, 1 s, 2 s, ..., each wait capped at 10 s, at most
 * TWOBA_MAX_RETRIES times (default 3, 0 = no retry).
 *
 * TwobaError carries an HTTP status for the caller: 4xx when the caller can fix
 * it (a bad code, a refused sign-in), 502/503/504 when 2BA failed. Its message
 * is ours, plus at most 2BA's own short message (tags off, cut): never the URL,
 * a token or a credential.
 *
 * `twobaTransport.fetch` and `.sleep` are the seams tests replace.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { envInt } = nodeRequire('../utils/envNumber.mts') as typeof import('../utils/envNumber.mts');

export const API_BASE = 'https://api.2ba.nl/1/json';
export const STREAMING_BASE = 'https://api.2ba.nl/1/streaming';
export const AUTH_BASE = 'https://authorize.2ba.nl';

/** The part of a fetch Response this integration reads. */
export interface TwobaResponse {
    ok: boolean;
    status: number;
    headers?: { get: (name: string) => string | null };
    text: () => Promise<string>;
}

export type TwobaFetch = (url: string, init: Record<string, unknown>) => Promise<TwobaResponse>;

export const twobaTransport: { fetch: TwobaFetch; sleep: (ms: number) => Promise<void> } = {
    fetch: async (url, init) => {
        const { fetchFixedEndpoint } = nodeRequire('../utils/fixedEndpointFetch.mts') as typeof import('../utils/fixedEndpointFetch.mts');
        return fetchFixedEndpoint(url, init as RequestInit) as Promise<TwobaResponse>;
    },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); }),
};

/** An error with the status the caller should answer with. */
export class TwobaError extends Error {
    readonly status: number;
    readonly code: string;
    readonly expose = true;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = 'TwobaError';
        this.status = status;
        this.code = code;
    }
}

export const MAX_DELAY_MS = 10_000;
const BASE_DELAY_MS = 500;
const MAX_MESSAGE_CHARS = 200;

export function maxRetries(): number {
    return envInt('TWOBA_MAX_RETRIES', 3, { min: 0, max: 10 });
}

/** Retry-After as ms (seconds only; an HTTP date counts as absent), capped. */
export function retryDelayMs(response: TwobaResponse, attempt: number): number {
    const header = response.headers?.get('retry-after');
    const seconds = header === null || header === undefined || header.trim() === '' ? NaN : Number(header);
    const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : BASE_DELAY_MS * 2 ** attempt;
    return Math.min(ms, MAX_DELAY_MS);
}

export interface TwobaInit {
    method?: string;
    headers?: Record<string, string>;
    /** A body, or a function that builds a fresh one per attempt (a FormData stream cannot be sent twice). */
    body?: string | FormData | (() => string | FormData);
    timeoutMs?: number;
}

function networkError(err: unknown): TwobaError {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return new TwobaError(504, 'twoba_timeout', '2BA did not answer in time. Try again later.');
    return new TwobaError(502, 'twoba_unreachable', '2BA could not be reached. Try again later.');
}

/** One request, retried on 429 and 503. Resolves to the last response, whatever its status. */
export async function twobaFetch(url: string, init: TwobaInit = {}): Promise<TwobaResponse> {
    const retries = maxRetries();
    for (let attempt = 0; ; attempt += 1) {
        const body = typeof init.body === 'function' ? init.body() : init.body;
        let response: TwobaResponse;
        try {
            response = await twobaTransport.fetch(url, {
                method: init.method || 'GET',
                headers: init.headers || {},
                ...(body === undefined ? {} : { body }),
                redirect: 'error',
                ...(init.timeoutMs ? { timeoutMs: init.timeoutMs } : {}),
            });
        } catch (err) {
            throw networkError(err);
        }
        if ((response.status !== 429 && response.status !== 503) || attempt >= retries) return response;
        await twobaTransport.sleep(retryDelayMs(response, attempt));
    }
}

/** The body as text, or '' when it cannot be read. */
export async function safeText(response: TwobaResponse): Promise<string> {
    try { return await response.text(); } catch { return ''; }
}

function stripTags(raw: string): string {
    let out = '';
    let inTag = false;
    for (const ch of raw) {
        if (ch === '<') inTag = true;
        else if (ch === '>' && inTag) { inTag = false; out += ' '; } else if (!inTag) out += ch;
    }
    return out.split(/\s+/).join(' ').trim();
}

/** 2BA's own short message from an error body (Message / message / error_description), or ''. */
export function twobaMessage(body: string): string {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return ''; }
    const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const raw = [obj.Message, obj.message, obj.error_description, obj.ExceptionMessage].find((v) => typeof v === 'string' && v.trim());
    if (typeof raw !== 'string') return typeof parsed === 'string' ? stripTags(parsed).slice(0, MAX_MESSAGE_CHARS) : '';
    const clean = stripTags(raw);
    return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS)}…` : clean;
}

const STATUS_ERRORS: Record<number, [number, string, string]> = {
    400: [400, 'twoba_bad_request', '2BA did not accept the request'],
    401: [401, 'twoba_unauthorized', '2BA refused the sign-in. Check the 2BA connection in Settings > Connections'],
    403: [403, 'twoba_forbidden', 'This 2BA account may not do this (for example: no Online Condition Server, or no right on that database)'],
    404: [404, 'twoba_not_found', '2BA found nothing for this request'],
    429: [503, 'twoba_rate_limited', '2BA is receiving too many requests. Try again later'],
    503: [503, 'twoba_unavailable', '2BA is temporarily unavailable. Try again later'],
};

/** The error for a failed answer: our sentence per status, plus 2BA's own message for a 4xx. */
export function errorForStatus(status: number, body: string): TwobaError {
    const known = STATUS_ERRORS[status];
    if (!known) {
        return status >= 500
            ? new TwobaError(502, 'twoba_server_error', `2BA answered with an error (HTTP ${status}). Try again later.`)
            : new TwobaError(502, 'twoba_unexpected', `2BA answered HTTP ${status}.`);
    }
    const [mapped, code, sentence] = known;
    const detail = status < 500 && status !== 429 ? twobaMessage(body) : '';
    return new TwobaError(mapped, code, detail ? `${sentence}: ${detail}` : `${sentence}.`);
}
