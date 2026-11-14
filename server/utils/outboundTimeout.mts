/**
 * outboundTimeout.mts: the default time-out of an outbound HTTP call.
 *
 * Every fetcher of the server (utils/ssrfGuard.safeFetch for user URLs,
 * core/http/configuredEndpointFetch for admin-set endpoints, fixedEndpointFetch for
 * vendor hosts and the operator's sidecars) runs its call through
 * `fetchWithTimeout`, so a peer that accepts the connection and never answers
 * cannot hold a request, a job or a worker slot for good.
 *
 * The rule, per call:
 *   - `timeoutMs` given: that bound, 0 = none. A caller `signal` still aborts
 *     (both are combined with AbortSignal.any).
 *   - no `timeoutMs`, a caller `signal`: the caller owns the lifetime and no
 *     default is added. In this tree a caller signal is its own time-out (a
 *     15-minute upload, an SDK's request timer) or the lifetime of a stream
 *     (an MCP SSE channel), and a shorter default would cut those.
 *   - neither: OUTBOUND_HTTP_TIMEOUT_MS (default 30 s, 0 = none).
 *
 * `timeoutPhase: 'headers'` bounds only the wait for the response headers,
 * for a stream or a large download whose body may take longer than any fixed
 * total. Undici's own bodyTimeout still ends a body that stops sending.
 */

export const OUTBOUND_TIMEOUT_ENV = 'OUTBOUND_HTTP_TIMEOUT_MS';
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

export type TimeoutPhase = 'total' | 'headers';

/** The options this layer reads; they are removed before the call goes out. */
export interface OutboundTimeoutOptions {
    timeoutMs?: number;
    timeoutPhase?: TimeoutPhase;
}

type InitWithSignal = { signal?: AbortSignal | null };

/** OUTBOUND_HTTP_TIMEOUT_MS in ms; unset, empty or not a number >= 0 gives the default. */
export function outboundTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env[OUTBOUND_TIMEOUT_ENV];
    const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_OUTBOUND_TIMEOUT_MS;
}

/**
 * A signal that fires after OUTBOUND_HTTP_TIMEOUT_MS, or undefined when it is
 * 0: for a call that keeps the plain fetch on purpose (the reason sits at the
 * call site) and still must not wait for ever.
 */
export function defaultTimeoutSignal(env: NodeJS.ProcessEnv = process.env): AbortSignal | undefined {
    const ms = outboundTimeoutMs(env);
    return ms > 0 ? AbortSignal.timeout(ms) : undefined;
}

/** The bound for this call in ms, 0 when none applies. */
export function effectiveTimeoutMs(init: OutboundTimeoutOptions & InitWithSignal, env: NodeJS.ProcessEnv = process.env): number {
    if (typeof init.timeoutMs === 'number') return Number.isFinite(init.timeoutMs) && init.timeoutMs > 0 ? init.timeoutMs : 0;
    if (init.signal) return 0;
    return outboundTimeoutMs(env);
}

function timeoutError(ms: number): DOMException {
    return new DOMException(`The outbound request timed out after ${ms} ms.`, 'TimeoutError');
}

function combined(signal: AbortSignal | null | undefined, timer: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, timer]) : timer;
}

/**
 * Run `fetchImpl(url, init)` under the time-out rule above. The time-out
 * aborts with a DOMException named TimeoutError (what AbortSignal.timeout
 * gives), so callers that already test for it keep working.
 */
export async function fetchWithTimeout<I extends InitWithSignal, R>(
    fetchImpl: (url: string | URL, init: I) => Promise<R>,
    url: string | URL,
    init: I & OutboundTimeoutOptions = {} as I & OutboundTimeoutOptions,
    env: NodeJS.ProcessEnv = process.env,
): Promise<R> {
    const { timeoutMs: _ms, timeoutPhase = 'total', ...rest } = init;
    const callInit = rest as unknown as I;
    const ms = effectiveTimeoutMs(init, env);
    if (ms === 0) return fetchImpl(url, callInit);
    if (timeoutPhase === 'total') {
        return fetchImpl(url, { ...callInit, signal: combined(callInit.signal, AbortSignal.timeout(ms)) });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(timeoutError(ms)), ms);
    timer.unref();
    try {
        return await fetchImpl(url, { ...callInit, signal: combined(callInit.signal, ctrl.signal) });
    } finally {
        clearTimeout(timer);
    }
}
