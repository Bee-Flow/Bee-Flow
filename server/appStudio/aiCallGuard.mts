/**
 * A time-out for one model call made by an App Studio action step.
 *
 * Without it a provider that stops answering holds the step (and the whole
 * sequence, and app_run_action) for as long as the provider's own socket
 * time-out, minutes, and leaves the records the sequence had already touched
 * half updated. This guard gives every call a deadline, ABORTS the request when
 * it passes (the signal reaches the provider SDK, see the adapters in
 * core/providers), retries ONCE after a time-out, and then fails the step with a
 * message the dispatcher passes through (see actionExecutor/dispatch.js).
 *
 * Only the app action path uses it. Other errors are not retried here.
 *
 * Limit: STUDIO_AI_CALL_TIMEOUT_MS, default 120000, 0 = no time-out (STUDIO_APP_AI_TIMEOUT_MS is
 * read as an alias when it is unset; aiRuntime's adapter timeoutMs reads the same value).
 * Logs carry the step kind, the model id, durations and a status or code, never
 * prompt text, document content or an error message from the provider.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const DEFAULT_AI_CALL_TIMEOUT_MS = 120_000;

type LogLike = { info: (...a: unknown[]) => void };
export type GuardDeps = { log?: LogLike; now?: () => number; env?: Record<string, string | undefined> };

/** Env value to milliseconds: unset, blank, negative or not a number gives the default; 0 means no time-out. */
export function aiCallTimeoutMs(env: Record<string, string | undefined> = process.env): number {
    const own = env.STUDIO_AI_CALL_TIMEOUT_MS;
    // The older STUDIO_APP_AI_TIMEOUT_MS (the adapters' timeoutMs) is an alias, read only when the knob is unset.
    const raw = own === undefined || String(own).trim() === '' ? env.STUDIO_APP_AI_TIMEOUT_MS : own;
    if (raw === undefined || String(raw).trim() === '') return DEFAULT_AI_CALL_TIMEOUT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_AI_CALL_TIMEOUT_MS;
    return Math.floor(n);
}

/** The step error: HttpError-shaped (status, code, safe) so the dispatcher keeps the message. */
export function aiTimeoutError(timeoutMs: number): Error {
    const { HttpError } = nodeRequire('../core/http/errors');
    const seconds = Math.round(timeoutMs / 1000);
    const e = new HttpError(504, 'ai_timeout', `The AI gave no answer within ${seconds} s`);
    e.safe = true;
    return e;
}

/** What may be logged about a failure: a status or code, never the message. */
function safeReason(e: unknown): string {
    const x = e as { status?: unknown; code?: unknown; name?: unknown } | null;
    if (typeof x?.status === 'number') return `status ${x.status}`;
    if (typeof x?.code === 'string') return x.code.slice(0, 60);
    return typeof x?.name === 'string' ? x.name.slice(0, 60) : 'error';
}

/** Rejects when the signal aborts; `pending` is silenced so a late answer or error is not an unhandled rejection. */
function abortion(signal: AbortSignal, pending: Promise<unknown>): Promise<never> {
    pending.catch(() => {});
    return new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

/**
 * Run `call` with an AbortSignal that fires after the configured time-out; one retry after a
 * time-out, then the step error. With the time-out off the call runs without a signal.
 */
export async function guardedAiCall<T>(
    call: (signal: AbortSignal | undefined) => Promise<T>,
    info: { kind: string; model: string },
    deps: GuardDeps = {},
): Promise<T> {
    const log = deps.log ?? nodeRequire('../telemetry/log');
    const now = deps.now ?? Date.now;
    const timeoutMs = aiCallTimeoutMs(deps.env);
    const tag = `[AppAI] ${info.kind} ${info.model}`;

    for (let attempt = 1; ; attempt += 1) {
        const t0 = now();
        const controller = timeoutMs > 0 ? new AbortController() : null;
        let timedOut = false;
        const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
        try {
            const pending = call(controller?.signal);
            // An adapter that ignores the signal must not keep the step waiting: the deadline wins the race.
            const out = controller ? await Promise.race([pending, abortion(controller.signal, pending)]) : await pending;
            log.info(`${tag} done in ${now() - t0} ms`);
            return out;
        } catch (e) {
            const ms = now() - t0;
            if (!timedOut) {
                log.info(`${tag} failed after ${ms} ms: ${safeReason(e)}`);
                throw e;
            }
            log.info(`${tag} timed out after ${ms} ms (attempt ${attempt})`);
            if (attempt >= 2) throw aiTimeoutError(timeoutMs);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
