/**
 * sseError.mts: what an SSE `error` event tells the client about a failure.
 *
 * The same rule as the terminal error handler (terminalErrorHandler.js): an
 * HttpError below 500 is meant for the client and keeps its message and code;
 * anything else is answered with the classified, fixed wording of
 * classifyStreamError and a correlationId, and the error itself goes to the
 * log under that id. A provider body, a path or a SQL fragment never reaches
 * the stream.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

export interface SseErrorPayload {
    error: string;
    errorType: string;
    correlationId: string;
    code?: string;
}

interface ClientError { status?: number; expose?: boolean; code?: string; message?: string }

/**
 * The payload for `send('error', ...)`. `tag` names the route in the log
 * line; `correlationId` defaults to the id of `req` when one is passed.
 */
export function sseErrorPayload(err: unknown, { tag, correlationId, req }: { tag: string; correlationId?: string | null; req?: object }): SseErrorPayload {
    const reqId = (req as { id?: unknown } | undefined)?.id;
    const id = correlationId || (typeof reqId === 'string' && reqId ? reqId : '') || randomUUID();
    const log = nodeRequire('../../telemetry/log.js');
    const e = (err && typeof err === 'object' ? err : new Error(String(err))) as Error & ClientError;
    if (e.expose === true && typeof e.status === 'number' && e.status < 500) {
        log.warn(`${tag} ${e.status} correlationId=${id}: ${e.code || ''}`);
        return { error: e.message || 'Request failed', errorType: 'permanent', correlationId: id, ...(e.code ? { code: e.code } : {}) };
    }
    const { classifyStreamError } = nodeRequire('../agentRuntime/streamRetry.js');
    const classified = classifyStreamError(e) as { retryable: boolean; userMessage: string };
    log.error(`${tag} failed correlationId=${id}`, e);
    return { error: classified.userMessage, errorType: classified.retryable ? 'transient' : 'permanent', correlationId: id };
}
