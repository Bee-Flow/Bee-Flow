// Centralised API client. Wraps `authFetch` with:
//   - method helpers (get/post/patch/delete)
//   - automatic JSON serialisation / parsing
//   - URLSearchParams build-out for `query`
//   - propagation of an `AbortSignal` (React Query provides one per query)
//   - exponential-backoff retry for network/5xx/408/429 on GET, HEAD and
//     OPTIONS only; a write retries only when its caller opts in
//   - a single throw site (`ApiError`) carrying status + parsed body
//
// Domain hooks (see /api/queries/) should consume `apiClient` rather than
// reaching for `authFetch` directly. The old direct-fetch call sites can
// migrate file-by-file.

import type { AuthFetchOptions } from '../utils/helpers';
import { API_BASE, authFetch } from '../utils/helpers';
import { errorStatus, isAbortError } from '../utils/caughtError';
import { logger } from '../utils/logger';

export interface ApiErrorInit {
    status?: number;
    body?: unknown;
}

export class ApiError extends Error {
    status?: number;
    body?: unknown;
    constructor(message: string, { status, body }: ApiErrorInit = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

export interface RetryOptions {
    attempts: number;
    base: number;
}

export type QueryParams =
    | URLSearchParams
    | Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
    signal?: AbortSignal;
    /** URL search params, accepts plain object or URLSearchParams. */
    query?: QueryParams;
    /** Additional headers; Content-Type is set automatically when body is JSON. */
    headers?: Record<string, string>;
    /**
     * Retry on a network error, 5xx, 408 or 429. Left out: a GET, HEAD or
     * OPTIONS retries with the default { attempts: 2, base: 250 }, any other
     * method sends once — a retried write whose first attempt did land (the
     * 5xx came after the commit, or the answer was lost) runs twice. `false`
     * never retries; `true` or a partial object (merged into the default)
     * retries whatever the method: opt in only where the server makes a
     * repeat harmless (a client-generated id it stores once).
     */
    retry?: boolean | Partial<RetryOptions>;
}

const DEFAULT_RETRY: RetryOptions = {
    attempts: 2,
    base: 250,
};

/** The methods that retry without being asked: they do not change anything on the server. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The retry plan for one request, or null for a single attempt. */
function retryPlan(method: string, retry: RequestOptions['retry']): RetryOptions | null {
    if (retry === false) return null;
    if (retry === undefined) return IDEMPOTENT_METHODS.has(method.toUpperCase()) ? DEFAULT_RETRY : null;
    return { ...DEFAULT_RETRY, ...(retry === true ? {} : retry) };
}

function buildUrl(path: string, query?: QueryParams): string {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    if (!query) return url;
    const entries: Array<[string, string]> = [];
    if (query instanceof URLSearchParams) {
        query.forEach((v, k) => entries.push([k, v]));
    } else {
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null) continue;
            entries.push([k, String(v)]);
        }
    }
    if (entries.length === 0) return url;
    const qs = new URLSearchParams(entries).toString();
    return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}

interface AttemptOptions extends RequestOptions {
    body?: unknown;
}

async function attempt<T>(method: string, path: string, opts: AttemptOptions = {}): Promise<T | null> {
    const { signal, body, query, headers } = opts;
    const url = buildUrl(path, query);
    const init: AuthFetchOptions = { method, signal };
    if (body !== undefined && body !== null) {
        init.headers = { 'Content-Type': 'application/json', ...(headers || {}) };
        init.body = JSON.stringify(body);
    } else if (headers) {
        init.headers = headers;
    }
    const res: Response = await authFetch(url, init);
    if (!res.ok) {
        let parsed: { error?: string } | null = null;
        try { parsed = await res.json(); } catch (err) { logger.debug('not JSON', err); }
        throw new ApiError(parsed?.error || `HTTP ${res.status}`, { status: res.status, body: parsed });
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json() as Promise<T>;
    return (await res.text()) as unknown as T;
}

async function request<T>(method: string, path: string, opts: AttemptOptions = {}): Promise<T | null> {
    const retry = retryPlan(method, opts.retry);
    let lastErr: unknown;
    for (let i = 0; i <= (retry ? retry.attempts : 0); i++) {
        try {
            return await attempt<T>(method, path, opts);
        } catch (e) {
            // Don't retry user-cancelled or 4xx (except 408/429).
            if (isAbortError(e)) throw e;
            if (e instanceof ApiError && e.status && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
            lastErr = e;
            if (!retry || i === retry.attempts) break;
            const delay = retry.base * 2 ** i;
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

export interface ApiClient {
    get<T = unknown>(path: string, opts?: RequestOptions): Promise<T | null>;
    post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null>;
    patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null>;
    put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null>;
    delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T | null>;
}

export const apiClient: ApiClient = {
    get: (path, opts) => request(`GET`, path, opts),
    post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts = {}) => request('PATCH', path, { ...opts, body }),
    put: (path, body, opts = {}) => request('PUT', path, { ...opts, body }),
    delete: (path, opts) => request('DELETE', path, opts),
};

export default apiClient;

// ---------------------------------------------------------------------------
// createJsonResource — the `request()` every studio API module used to carry
// its own copy of. Unlike `apiClient` it keeps those modules' contract
// exactly: ONE attempt for every method, a GET included (no retry unless
// asked), the server's `error` text verbatim (falling back to
// "Request failed (<status>)"), and a thrown Error carrying `status`, `code`
// and the parsed `body`. The resolved value is the parsed JSON body, or null
// when the answer had none.
// ---------------------------------------------------------------------------

/** The Error a resource request throws on a non-2xx answer. */
export interface JsonResourceError extends Error {
    status: number;
    code: string | null;
    body: unknown;
    [extra: string]: unknown;
}

/** Init for one resource call: a fetch init whose body may be a plain object. */
export interface JsonResourceInit extends Omit<RequestInit, 'body' | 'headers'> {
    body?: unknown;
    headers?: Record<string, string>;
}

export interface JsonResourceOptions {
    /**
     * When to send `Content-Type: application/json`:
     *  - 'json' (default): on every call except a FormData body (which sets
     *    its own multipart boundary); the caller's headers win.
     *  - 'body': only when the call carries a body.
     *  - 'none': never — the caller passes its own headers.
     */
    contentType?: 'json' | 'body' | 'none';
    /** JSON.stringify a body that is not already a string or FormData. Default true. */
    encodeBody?: boolean;
    /** Message when the error body carries no `error`. Default "Request failed (<status>)". */
    errorText?: (status: number) => string;
    /** Add module-specific fields (retryAfter, managed, field, ...) to the thrown error. */
    decorate?: (err: JsonResourceError, body: Record<string, unknown> | null, res: Response) => void;
    /** Retry on network errors / 5xx / 408 / 429. Off by default (see above). */
    retry?: false | Partial<RetryOptions>;
}

// The default is `any` on purpose: the JS modules that call this read the
// body field by field exactly as they did with `await res.json()`; a TS caller
// names its type.
export type JsonResourceRequest = <T = any>(path?: string, init?: JsonResourceInit) => Promise<T>;

const isFormData = (b: unknown): boolean => typeof FormData !== 'undefined' && b instanceof FormData;

/**
 * A `request(path, init)` bound to `base` (prepended verbatim, '' for callers
 * that pass whole URLs).
 */
export function createJsonResource(base = '', options: JsonResourceOptions = {}): JsonResourceRequest {
    const {
        contentType = 'json',
        encodeBody = true,
        errorText = (status: number) => `Request failed (${status})`,
        decorate,
        retry = false,
    } = options;

    function toFetchInit(init: JsonResourceInit): AuthFetchOptions {
        const { body: rawBody, headers: callerHeaders, ...rest } = init;
        const fetchInit: AuthFetchOptions = { ...rest };
        const hasBody = rawBody !== undefined;
        const form = isFormData(rawBody);
        const wantsJson = (contentType === 'json' && !form) || (contentType === 'body' && hasBody);
        const headers = wantsJson ? { 'Content-Type': 'application/json', ...callerHeaders } : callerHeaders;
        if (headers) fetchInit.headers = headers;
        if (!hasBody) return fetchInit;
        const encode = encodeBody && typeof rawBody !== 'string' && !form;
        fetchInit.body = (encode ? JSON.stringify(rawBody) : rawBody) as BodyInit;
        return fetchInit;
    }

    async function once<T>(url: string, init: JsonResourceInit): Promise<T> {
        const res: Response = await authFetch(url, toFetchInit(init));
        let parsed: Record<string, unknown> | null = null;
        try { parsed = await res.json(); } catch (err) { logger.debug('empty or non-JSON body', err); }
        if (res.ok) return parsed as T;
        const err = new Error((parsed?.error as string) || errorText(res.status)) as JsonResourceError;
        err.status = res.status;
        err.code = (parsed?.code as string) || null;
        err.body = parsed;
        decorate?.(err, parsed, res);
        throw err;
    }

    return async function request<T = any>(path = '', init: JsonResourceInit = {}): Promise<T> {
        const url = `${base}${path}`;
        if (retry === false) return once<T>(url, init);
        const r: RetryOptions = { ...DEFAULT_RETRY, ...retry };
        let lastErr: unknown;
        for (let i = 0; i <= r.attempts; i++) {
            try {
                return await once<T>(url, init);
            } catch (e) {
                if (isAbortError(e)) throw e;
                const status = errorStatus(e);
                if (status && status < 500 && status !== 408 && status !== 429) throw e;
                lastErr = e;
                if (i === r.attempts) break;
                await new Promise((res) => setTimeout(res, r.base * 2 ** i));
            }
        }
        throw lastErr;
    };
}
