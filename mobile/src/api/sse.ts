/**
 * Server-sent events over a POST body.
 *
 * Bee Flow's streams are not `EventSource`-shaped: every one of them is a POST
 * with a JSON body (the chat turn, the automation run, the notebook build), and
 * EventSource can only issue a GET. The web client solves this by reading a
 * fetch response body incrementally; this is the same approach on
 * `expo/fetch`, which is the only fetch in React Native that exposes
 * `response.body` as a real ReadableStream.
 *
 * Wire format, from server/core/http/sseHelpers.js and the send() in
 * routes/ai/directChat/streamTurn.js:
 *
 *     event: <name>\n
 *     data: <json>\n
 *     \n
 *
 * plus a heartbeat that writes BOTH a comment frame (`: ping`) and a real
 * `ping` event every 10s, because different intermediaries reset their idle
 * timers on different things. Comments are skipped here and `ping` is routed
 * to nothing, exactly as useChatEngine.handleSSEEvent does.
 */

import { fetch as expoFetch } from 'expo/fetch';

import { ApiError, asOfflineError, authHeaders } from './client';
import { apiUrl } from './server';

export interface SseFrame {
    /** Event name. Defaults to 'message' when the server omits `event:`. */
    event: string;
    /** Parsed `data:` payload. Non-JSON data arrives as a string. */
    data: unknown;
}

export interface SseOptions {
    /** JSON body to POST. Omit for a GET stream. */
    body?: unknown;
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
 * Open a stream and yield frames as they arrive.
 *
 * Async generator rather than a callback so a consumer can `for await` and
 * keep its state in local variables — the chat reducer is far easier to reason
 * about that way than as a switch inside a callback closure.
 */
export async function* streamSse(path: string, opts: SseOptions = {}): AsyncGenerator<SseFrame> {
    const {
        body,
        method = body === undefined ? 'GET' : 'POST',
        headers,
        signal,
        idleTimeoutMs = DEFAULT_IDLE_TIMEOUT,
    } = opts;

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller);

    // Reset on every chunk; fires only if the stream goes quiet entirely.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };

    // Built as a flat record rather than by spreading conditionals: a spread of
    // `cond ? {k: v} : {}` widens to a union of object shapes that no longer
    // satisfies HeadersInit. `authHeaders` carries the SSO bridge token, which
    // a stream needs as much as any other request — without it an SSO user
    // finds lists load and every STREAM 401s.
    const requestHeaders: Record<string, string> = authHeaders({
        Accept: 'text/event-stream',
        ...(headers ?? {}),
    });
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

    try {
        bumpIdle();
        const res = await expoFetch(apiUrl(path), {
            method,
            signal: controller.signal,
            credentials: 'include',
            headers: requestHeaders,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }).catch((err: unknown) => {
            // Same rule as the client: a transport failure with no network
            // is the device being offline, and the screen should say so.
            throw asOfflineError(err) ?? err;
        });

        if (!res.ok) {
            // A stream that fails before the first frame answers with a normal
            // JSON error body (sendSSEError is the exception — it answers 200
            // and puts the error IN the stream, which the consumer sees as an
            // `error` frame).
            let parsed: unknown = null;
            try {
                parsed = await res.json();
            } catch {
                /* not JSON */
            }
            const message =
                (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
            throw new ApiError(message, { status: res.status, body: parsed });
        }

        if (!res.body) throw new ApiError('The server sent no stream body.');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bumpIdle();
                buffer += decoder.decode(value, { stream: true });

                // Frames are separated by a blank line. \r\n is tolerated
                // because some proxies rewrite line endings.
                let sep = findFrameEnd(buffer);
                while (sep !== -1) {
                    const raw = buffer.slice(0, sep.index);
                    buffer = buffer.slice(sep.index + sep.length);
                    const frame = parseFrame(raw);
                    if (frame) yield frame;
                    sep = findFrameEnd(buffer);
                }
            }
            // A stream can end without a trailing blank line.
            const tail = parseFrame(buffer);
            if (tail) yield tail;
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

function findFrameEnd(buffer: string): { index: number; length: number } | -1 {
    const lf = buffer.indexOf('\n\n');
    const crlf = buffer.indexOf('\r\n\r\n');
    if (lf === -1 && crlf === -1) return -1;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
}

/**
 * Parse one frame. Returns null for a frame that carries no event — a comment
 * heartbeat, or the trailing empty string after the last separator.
 */
function parseFrame(raw: string): SseFrame | null {
    if (!raw.trim()) return null;
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of raw.split(/\r?\n/)) {
        // ':' in column 0 is a comment (the `: ping` heartbeat).
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        // Per spec a single leading space after the colon is part of the
        // delimiter, not the value.
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        if (field === 'event') event = value;
        else if (field === 'data') dataLines.push(value);
        // `id` and `retry` are unused: these streams are one-shot POSTs with
        // no resume, so a Last-Event-ID would have nothing to resume from.
    }

    if (!dataLines.length) return null;
    const payload = dataLines.join('\n');
    let data: unknown = payload;
    try {
        data = JSON.parse(payload);
    } catch {
        /* the server always sends JSON, but a proxy error page might not */
    }
    return { event, data };
}
