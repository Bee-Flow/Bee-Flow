/**
 * The HTTP client. A port of agent-hub/src/api/client.ts, keeping its
 * behaviour (method helpers, JSON handling, query building, backoff retry, one
 * throw site) and adding what only a phone needs.
 *
 * Two deliberate differences from the web client:
 *
 *   1. `expo/fetch`, not the global `fetch`. React Native's built-in fetch
 *      cannot stream a response body, and chat is a stream. Rather than run
 *      two networking stacks with two cookie jars, everything goes through
 *      expo/fetch — which on Android is OkHttp wired to the same
 *      ForwardingCookieHandler as RN's own client, so the session cookie is
 *      shared no matter which path a request takes.
 *
 *   2. A 401 does NOT reload the app. The web client calls
 *      window.location.reload() to bounce to the login page; on a phone that
 *      would throw away unsent input and any in-flight recording. Instead a
 *      401 notifies the auth layer, which shows the lock screen over whatever
 *      the user was doing and puts them back afterwards.
 */

import { fetch as expoFetch } from 'expo/fetch';

import { apiUrl, NoServerConfiguredError } from './server';

/**
 * A machine code such as `training_required`, as opposed to a sentence. Many
 * routes answer `{ error: '<code>', message: '<sentence>' }`, and which of the
 * two is the one to show depends on this.
 */
function isErrorCode(value: string): boolean {
    return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value);
}

export class ApiError extends Error {
    status?: number;
    body?: unknown;
    /**
     * The machine-readable reason, when the server gave one: `body.code`, else
     * `body.error` when that is a code rather than a sentence. Screens branch
     * on this; the message is for people.
     */
    get code(): string | undefined {
        const body = this.body;
        if (!body || typeof body !== 'object') return undefined;
        const { code, error } = body as { code?: unknown; error?: unknown };
        if (typeof code === 'string' && code) return code;
        if (typeof error === 'string' && isErrorCode(error)) return error;
        return undefined;
    }
    /** True when the server refused because of licensing/quota (402). */
    get isQuota(): boolean {
        return this.status === 402;
    }
    /** True when the caller is not entitled to this feature (403). */
    get isForbidden(): boolean {
        return this.status === 403;
    }
    constructor(message: string, init: { status?: number; body?: unknown } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = init.status;
        this.body = init.body;
    }
}

/** Raised when the device has no usable network, so callers can say so. */
export class OfflineError extends Error {
    constructor() {
        super('You appear to be offline.');
        this.name = 'OfflineError';
    }
}

/**
 * The platform's last word on connectivity, bridged from NetInfo in
 * app/_layout.tsx. Unknown (`null`) counts as online: a request is worth
 * trying until the network says otherwise.
 */
let connectivity: boolean | null = null;

export function setConnectivity(online: boolean | null): void {
    connectivity = online;
}

export function isOffline(): boolean {
    return connectivity === false;
}

/**
 * A transport failure — fetch itself threw, so the server never answered —
 * while the platform reports no network IS the device being offline, and no
 * retry can change that. A server answer, even a 5xx, is not.
 */
export function asOfflineError(err: unknown): OfflineError | null {
    if (err instanceof ApiError || err instanceof NoServerConfiguredError) return null;
    return isOffline() ? new OfflineError() : null;
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
    signal?: AbortSignal;
    query?: QueryParams;
    headers?: Record<string, string>;
    /**
     * `false` disables retries; a partial object merges into the default.
     * Only GET and HEAD retry when this is omitted: any other method retries
     * only when given an object (`{}` for the defaults), because a write that
     * timed out may still have landed, and sending it again can create a
     * second skill or flip a toggle straight back. The exception is a refusal
     * that proves the handler never ran (see `neverReachedHandler`): that
     * write is retried like a read.
     */
    retry?: false | Partial<{ attempts: number; base: number }>;
    /** Overall deadline. Separate from `signal` so callers get both. */
    timeoutMs?: number;
}

const DEFAULT_RETRY = { attempts: 2, base: 250 };
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);
const DEFAULT_TIMEOUT = 30_000;

/**
 * A refusal that proves the request was never processed, so sending a write
 * again cannot do it twice: a 429 from the rate limiter, and the 503
 * `entitlement_unavailable` (with `Retry-After: 1`) that requireCapability
 * answers from middleware while entitlements are momentarily unresolvable
 * (server/core/entitlements/entitlements.js). A bare 503 or a timeout says
 * nothing about whether the write landed, so it does not qualify.
 */
function neverReachedHandler(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    return err.status === 429 || (err.status === 503 && err.code === 'entitlement_unavailable');
}

type UnauthorizedHandler = (path: string) => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/**
 * The SSO session token, when there is one.
 *
 * Native SSO cannot use a cookie. RFC 8252 says the OAuth round trip belongs in
 * a real browser, and this app has no WebView by design — but Android's Custom
 * Tab keeps its own cookie jar, so the session cookie the OAuth callback sets
 * never reaches expo/fetch. The server already solves exactly this for its
 * embedded-iframe case: `?popup=1&pickup=<id>` makes the callback deposit a
 * session token instead of redirecting, /auth/login-pickup hands it to the
 * app, and the middleware at server/index.js:316 rebuilds req.session from an
 * `X-Session-Token` header on every request.
 *
 * So the token has to ride on EVERY request, not just the next one — hence a
 * module-level value rather than a per-call option. Password and OPAQUE
 * sign-ins leave this null and keep using the cookie jar, which is why this is
 * additive rather than a replacement.
 */
let sessionToken: string | null = null;

/**
 * Install or clear the SSO session token. Called by src/core/auth/sessionToken.ts,
 * which owns persisting it and re-minting it before the server's TTL runs out.
 */
export function setSessionToken(token: string | null): void {
    sessionToken = token;
}

export function getSessionToken(): string | null {
    return sessionToken;
}

/**
 * The headers every request to a Bee Flow server carries, whichever code path
 * sends it.
 *
 * This exists because the request path is not one function. `request()` below
 * is the common case, but chat and voice stream through expo/fetch directly
 * (src/core/api/sse.ts), a file download reads an
 * arrayBuffer (core/api/shareFile.ts) and the uploads that report progress
 * use XMLHttpRequest (src/core/api/xhrUpload.ts) — five call sites, each of which
 * used to spell its own headers out. That is exactly how an SSO user ends up
 * with an app where lists load and uploads 401: one of them forgets the token.
 * Anything the caller passes wins, which is what lets the SSO pickup read
 * /auth/user under a token that is not installed yet.
 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
        // The server keys some behaviour off the client; naming ourselves makes
        // mobile traffic identifiable in server logs without any per-user
        // identifier.
        'X-Beeflow-Client': 'android',
    };
    // Present only for an SSO session; see setSessionToken above.
    if (sessionToken) headers['X-Session-Token'] = sessionToken;
    return { ...headers, ...(extra ?? {}) };
}

/**
 * Register the auth layer's 401 handler. Kept as a setter rather than an
 * import so this module has no dependency on the auth store — the store
 * imports the client, not the other way round.
 */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
    onUnauthorized = fn;
}

/**
 * Paths where a 401 is the expected answer rather than an expired session.
 * Mirrors the exclusion list in agent-hub's authFetch: the login flow, the
 * public health probe, and the i18n fetches that legitimately run signed out.
 */
function is401Expected(path: string): boolean {
    return (
        path.includes('/auth/') ||
        // Minting a fresh bridge token is how the auth layer keeps an SSO
        // session alive; a 401 here means it did not get to it in time. The
        // auth layer clears the token and re-resolves the stage itself, so
        // firing the global handler as well would re-enter that same resolve.
        path.includes('/api/session-token') ||
        path.includes('/api/health') ||
        path.includes('/api/languages/') ||
        path.includes('/api/branding/public')
    );
}

/**
 * Tell the auth layer that `path` answered 401, unless 401 is that path's
 * normal answer. Exported for the requests that do not go through
 * `request()` — the streams, the file download and the XHR uploads — so an
 * expired session shows the lock screen whichever path found out first.
 */
export function notifyUnauthorized(path: string): void {
    if (!is401Expected(path)) onUnauthorized?.(path);
}

/**
 * The ApiError for a refusal whose body has already been parsed (`null` when
 * it was not JSON). The sentence is the server's `error` when that is prose —
 * the HttpError shape — else its `message`, because reading `error` first
 * shows `{ error: 'training_required', message: 'Finish the course…' }` to a
 * person as "training_required".
 */
export function apiErrorFromBody(status: number, body: unknown, fallback = `HTTP ${status}`): ApiError {
    const { error, message } = (body && typeof body === 'object' ? body : {}) as {
        error?: unknown;
        message?: unknown;
    };
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    const err = text(error);
    // A bare code still beats the status: it at least says what refused.
    const sentence = (err && !isErrorCode(err) ? err : undefined) ?? text(message) ?? err ?? fallback;
    return new ApiError(sentence, { status, body });
}

/**
 * Read a fetch response that was not ok into an ApiError, notifying the auth
 * layer on a 401. Shared by every expo/fetch path so none of them can forget
 * either half.
 */
export async function errorFromResponse(
    path: string,
    res: { status: number; json: () => Promise<unknown> },
): Promise<ApiError> {
    if (res.status === 401) notifyUnauthorized(path);
    let parsed: unknown = null;
    try {
        parsed = await res.json();
    } catch {
        /* not JSON — the message falls back to the status */
    }
    return apiErrorFromBody(res.status, parsed);
}

function buildUrl(path: string, query?: QueryParams): string {
    const url = apiUrl(path);
    if (!query) return url;
    const entries: string[] = [];
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        entries.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    if (!entries.length) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${entries.join('&')}`;
}

interface AttemptOptions extends RequestOptions {
    body?: unknown;
}

async function attempt<T>(method: string, path: string, opts: AttemptOptions): Promise<T | null> {
    const { body, query, headers, signal, timeoutMs = DEFAULT_TIMEOUT } = opts;
    const url = buildUrl(path, query);

    // A caller's signal and our deadline both have to be able to cancel.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller);

    try {
        const init: Parameters<typeof expoFetch>[1] = {
            method,
            signal: controller.signal,
            // Explicit rather than relying on the default: the session cookie
            // is the whole authentication story, and a future default change
            // would silently sign everyone out.
            credentials: 'include',
            headers: {
                Accept: 'application/json',
                ...authHeaders(headers),
            },
        };
        if (body instanceof FormData) {
            // Do NOT set Content-Type — the boundary has to come from the
            // runtime or the server cannot parse the upload.
            init.body = body;
        } else if (body !== undefined && body !== null) {
            init.headers = { ...init.headers, 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }

        const res = await expoFetch(url, init);

        if (!res.ok) throw await errorFromResponse(path, res);

        if (res.status === 204) return null;
        const contentType = res.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) return (await res.json()) as T;
        return (await res.text()) as unknown as T;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromCaller);
    }
}

/**
 * The error to throw at once, without retrying — or null when a retry may
 * help. A caller-cancelled request is not a failure to retry (the deadline also
 * aborts, so the caller's signal is checked rather than the name); a settled
 * 4xx is an answer, except 408 and 429; and offline is not retried, because the
 * backoff cannot change it.
 */
function failsWithoutRetry(err: unknown, signal?: AbortSignal): { error: unknown } | null {
    if (err instanceof NoServerConfiguredError) return { error: err };
    if (signal?.aborted) return { error: err };
    const status = err instanceof ApiError ? err.status : undefined;
    if (status && status < 500 && status !== 408 && status !== 429) return { error: err };
    const offline = asOfflineError(err);
    return offline ? { error: offline } : null;
}

async function request<T>(method: string, path: string, opts: AttemptOptions = {}): Promise<T | null> {
    // Omitted means "retry if it is safe to": only a read can be sent twice
    // without knowing whether the first attempt landed, and a write only when
    // the refusal proves it never did. See RequestOptions.
    const retry = opts.retry === false ? null : { ...DEFAULT_RETRY, ...opts.retry };
    const writeByDefault = opts.retry === undefined && !IDEMPOTENT_METHODS.has(method);
    let lastErr: unknown;

    for (let i = 0; i <= (retry ? retry.attempts : 0); i++) {
        try {
            return await attempt<T>(method, path, opts);
        } catch (err) {
            const fatal = failsWithoutRetry(err, opts.signal);
            if (fatal) throw fatal.error;
            lastErr = err;
            if (!retry || i === retry.attempts) break;
            if (writeByDefault && !neverReachedHandler(err)) break;
            await new Promise((r) => setTimeout(r, retry.base * 2 ** i));
        }
    }
    throw lastErr;
}

export const api = {
    get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
    post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
        request<T>('POST', path, { ...opts, body }),
    put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
        request<T>('PUT', path, { ...opts, body }),
    patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
        request<T>('PATCH', path, { ...opts, body }),
    delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
    /**
     * Multipart upload. Separate from post() because uploads want a much
     * longer deadline and no retry — re-sending a 40 MB recording because the
     * first attempt timed out is how you burn a user's data plan.
     */
    upload: <T>(path: string, form: FormData, opts?: RequestOptions) =>
        request<T>('POST', path, {
            timeoutMs: 5 * 60_000,
            retry: false,
            ...opts,
            body: form,
        }),
};
