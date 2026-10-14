/**
 * One reader for the Server-Sent Events that fetch-streamed POSTs answer with.
 *
 * EventSource cannot send auth headers, so every streamed endpoint is read
 * with `fetch` + `ReadableStream`. Each hook used to carry its own copy of the
 * same decode / split / buffer loop; they now iterate this instead.
 *
 * Three layers, each an async iterator:
 *   - `readSseLines`   decoded lines, CR stripped, the unterminated tail
 *                      flushed when the body ends.
 *   - `readSseFrames`  blank-line separated frames (what a long-lived feed
 *                      with `id:` cursors wants). An unterminated last frame is
 *                      dropped, as the SSE spec says.
 *   - `readEventStream` one `{ event, data }` per `data:` line, JSON parsed.
 *
 * Abort: pass the request's `signal`. An aborted signal makes the iterator
 * throw the signal's reason (an `AbortError`), exactly like a `reader.read()`
 * on an aborted fetch does, so callers keep telling a stop from a drop by
 * `err.name === 'AbortError'`. Breaking out of a `for await` early cancels the
 * underlying reader.
 */

/** What can be read: a fetch Response, or its body. */
export type EventStreamSource = Response | ReadableStream<Uint8Array> | null | undefined;

export interface ReadStreamOptions {
    /** Stop reading (throwing the abort reason) once this aborts. */
    signal?: AbortSignal;
}

export interface ReadEventStreamOptions extends ReadStreamOptions {
    /**
     * The event name for a `data:` line that no `event:` line preceded.
     * Default 'message' (the SSE default).
     */
    defaultEvent?: string;
    /** Called for a `data:` line that is not valid JSON; the line is skipped. */
    onInvalidData?: (event: string, raw: string, error: unknown) => void;
}

/** One parsed event. */
export interface SseMessage<T = unknown> {
    event: string;
    data: T;
}

function bodyOf(source: EventStreamSource): ReadableStream<Uint8Array> {
    const body = source && 'getReader' in source ? source : source?.body;
    if (!body || typeof body.getReader !== 'function') {
        throw new Error('readEventStream: response has no readable body');
    }
    return body;
}

function stripCr(line: string): string {
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Decoded lines of the body, in order. A chunk can split a line, so the tail
 * is held until the next chunk completes it; whatever is left when the body
 * ends is flushed as the last line(s) — a terminal event often arrives
 * without a trailing newline.
 */
export async function* readSseLines(source: EventStreamSource, { signal }: ReadStreamOptions = {}): AsyncGenerator<string> {
    const reader = bodyOf(source).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    try {
        for (;;) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) yield stripCr(line);
        }
        buffer += decoder.decode();
        finished = true;
        if (buffer) {
            for (const line of buffer.split('\n')) yield stripCr(line);
        }
    } finally {
        // Only an early exit (break, throw, abort) leaves the body unread.
        if (!finished && typeof reader.cancel === 'function') {
            reader.cancel().catch(() => { /* already errored or closed */ });
        }
    }
}

/**
 * Blank-line separated frames, each the frame's lines joined with '\n'. A
 * frame the body ended in the middle of is never yielded.
 */
export async function* readSseFrames(source: EventStreamSource, options: ReadStreamOptions = {}): AsyncGenerator<string> {
    let lines: string[] = [];
    let open = false;
    for await (const line of readSseLines(source, options)) {
        if (line === '') {
            if (open) yield lines.join('\n');
            lines = [];
            open = false;
        } else {
            lines.push(line);
            open = true;
        }
    }
}

/** The value of a `field:` line (one optional space after the colon), or null. */
function fieldValue(line: string, field: string): string | null {
    if (!line.startsWith(field) || line[field.length] !== ':') return null;
    const rest = line.slice(field.length + 1);
    return rest.startsWith(' ') ? rest.slice(1) : rest;
}

/**
 * Parsed events. Every `data:` line is one event, carrying the name of the
 * last `event:` line seen (servers frame `event:` before `data:`). A `data:`
 * line that is not JSON is skipped. The space after the colon is optional and
 * CRLF framing (a re-framing proxy) is accepted.
 */
export async function* readEventStream<T = unknown>(
    source: EventStreamSource,
    { defaultEvent = 'message', onInvalidData, ...options }: ReadEventStreamOptions = {},
): AsyncGenerator<SseMessage<T>> {
    let event = defaultEvent;
    for await (const line of readSseLines(source, options)) {
        const name = fieldValue(line, 'event');
        if (name !== null) { event = name.trim(); continue; }
        const raw = fieldValue(line, 'data');
        if (raw === null) continue;
        let data: T;
        try {
            data = JSON.parse(raw) as T;
        } catch (err) {
            onInvalidData?.(event, raw, err);
            continue;
        }
        yield { event, data };
    }
}

export default readEventStream;
