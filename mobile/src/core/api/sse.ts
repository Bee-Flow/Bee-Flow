/**
 * Server-sent events over a POST body.
 *
 * Bee Flow's streams are not `EventSource`-shaped: every one of them is a POST
 * (the chat turn, the automation run, the notebook build, the voice turn), and
 * EventSource can only issue a GET. The web client solves this by reading a
 * fetch response body incrementally; this is the same approach on
 * `expo/fetch`, which is the only fetch in React Native that exposes
 * `response.body` as a real ReadableStream.
 *
 * The frames themselves are cut by sseFrame.ts. The server's heartbeat writes
 * BOTH a comment frame (`: ping`) and a real `ping` event every 10s, because
 * different intermediaries reset their idle timers on different things;
 * comments are skipped there and `ping` is routed to nothing by the consumers,
 * exactly as useChatEngine.handleSSEEvent does.
 */

import { fetch as expoFetch } from 'expo/fetch';

import { ApiError, asOfflineError, authHeaders, errorFromResponse } from './client';
import { apiUrl } from './server';
import { readFrames, type SseFrame } from './sseFrame';

export type { SseFrame } from './sseFrame';

/**
 * A body that is not JSON — voice's multipart turn. The caller owns the bytes
 * and the Content-Type (with its boundary); nothing here re-encodes them.
 */
export interface RawBody {
    bytes: Uint8Array<ArrayBuffer>;
    contentType: string;
}

export interface SseOptions {
    /** JSON body to POST. Omit for a GET stream. */
    body?: unknown;
    /** A pre-encoded body, POSTed as-is instead of `body`. */
    rawBody?: RawBody;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /**
     * How long to wait with NO bytes at all before giving up. The server
     * heartbeats every 10s, so silence for much longer than that means the
     * connection is dead even though the socket has not said so — the exact
     * failure a phone hits when it walks out of wifi range.
     */
    idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT = 60_000;

/**
 * Headers and body. Built as a flat record rather than by spreading
 * conditionals: a spread of `cond ? {k: v} : {}` widens to a union of object
 * shapes that no longer satisfies HeadersInit. `authHeaders` carries the SSO
 * bridge token, which a stream needs as much as any other request — without
 * it an SSO user finds lists load and every STREAM 401s.
 */
function requestOf(opts: SseOptions): { headers: Record<string, string>; body?: BodyInit } {
    const headers: Record<string, string> = authHeaders({
        Accept: 'text/event-stream',
        ...(opts.headers ?? {}),
    });
    if (opts.rawBody) {
        headers['Content-Type'] = opts.rawBody.contentType;
        return { headers, body: opts.rawBody.bytes };
    }
    if (opts.body === undefined) return { headers };
    headers['Content-Type'] = 'application/json';
    return { headers, body: JSON.stringify(opts.body) };
}

/**
 * Open a stream and yield frames as they arrive.
 *
 * Async generator rather than a callback so a consumer can `for await` and
 * keep its state in local variables — the chat reducer is far easier to reason
 * about that way than as a switch inside a callback closure.
 */
export async function* streamSse(path: string, opts: SseOptions = {}): AsyncGenerator<SseFrame> {
    const { signal, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT } = opts;
    const request = requestOf(opts);
    const method = opts.method ?? (request.body === undefined ? 'GET' : 'POST');

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller);

    // Reset on every chunk; fires only if the stream goes quiet entirely.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };

    try {
        bumpIdle();
        const res = await expoFetch(apiUrl(path), {
            method,
            signal: controller.signal,
            credentials: 'include',
            headers: request.headers,
            ...(request.body !== undefined ? { body: request.body } : {}),
        }).catch((err: unknown) => {
            // Same rule as the client: a transport failure with no network
            // is the device being offline, and the screen should say so.
            throw asOfflineError(err) ?? err;
        });

        // A stream that fails before the first frame answers with a normal
        // JSON error body (sendSSEError is the exception — it answers 200 and
        // puts the error IN the stream, which the consumer sees as an `error`
        // frame). A 401 here is a session that expired mid-conversation, and
        // must bring up the lock screen like any other request's would.
        if (!res.ok) throw await errorFromResponse(path, res);

        if (!res.body) throw new ApiError('The server sent no stream body.');

        const reader = res.body.getReader();
        try {
            yield* readFrames(reader, bumpIdle);
        } finally {
            // Cancelling the reader is what actually closes the socket, which
            // is what makes the server's res.on('close') fire and abort the
            // model call. Without it a user leaving the screen keeps burning
            // tokens.
            await reader.cancel().catch(() => {});
        }
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        signal?.removeEventListener('abort', abortFromCaller);
        controller.abort();
    }
}
