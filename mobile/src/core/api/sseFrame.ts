/**
 * The one SSE framer: bytes in, `{event, data}` frames out.
 *
 * Every stream in the app (chat, agents, notebooks, runs, voice) is read
 * through this, so a proxy quirk — `\r\n` framing, `data:` without a space —
 * is fixed once. It lives in core/api because the transport in sse.ts needs
 * it and core may not import shared; features reach it through that transport.
 *
 * Wire format (server/core/http/sseHelpers.js):
 *
 *     event: <name>\n
 *     data: <json>\n
 *     \n
 *
 * plus a `: ping` comment heartbeat, which produces no frame.
 */

export interface SseFrame {
    /** Event name. Defaults to 'message' when the server omits `event:`. */
    event: string;
    /** Parsed `data:` payload. Non-JSON data arrives as a string. */
    data: unknown;
}

/** Where the next frame ends, tolerating `\r\n` from proxies that rewrite line endings. */
export function findFrameEnd(buffer: string): { index: number; length: number } | -1 {
    const lf = buffer.indexOf('\n\n');
    const crlf = buffer.indexOf('\r\n\r\n');
    if (lf === -1 && crlf === -1) return -1;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
}

/** One `field: value` line. Per spec a single leading space after the colon is delimiter. */
function splitLine(line: string): { name: string; value: string } {
    const colon = line.indexOf(':');
    if (colon === -1) return { name: line, value: '' };
    const value = line.slice(colon + 1);
    return { name: line.slice(0, colon), value: value.startsWith(' ') ? value.slice(1) : value };
}

function parseData(payload: string): unknown {
    try {
        return JSON.parse(payload);
    } catch {
        // The server always sends JSON, but a proxy error page might not.
        return payload;
    }
}

/**
 * Parse one frame. Returns null for a frame that carries no event — a comment
 * heartbeat, or the trailing empty string after the last separator.
 */
export function parseFrame(raw: string): SseFrame | null {
    if (!raw.trim()) return null;
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of raw.split(/\r?\n/)) {
        // ':' in column 0 is a comment (the `: ping` heartbeat).
        if (line.startsWith(':')) continue;
        const { name, value } = splitLine(line);
        if (name === 'event') event = value;
        else if (name === 'data') dataLines.push(value);
        // `id` and `retry` are unused: these streams are one-shot POSTs with
        // no resume, so a Last-Event-ID would have nothing to resume from.
    }

    if (!dataLines.length) return null;
    return { event, data: parseData(dataLines.join('\n')) };
}

/**
 * Split a body stream into frames as bytes arrive. A stream may end without a
 * trailing blank line — the last `done` often does — so the tail is parsed too.
 */
export async function* readFrames(
    reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
    onChunk: () => void,
): AsyncGenerator<SseFrame> {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk();
        buffer += decoder.decode(value, { stream: true });
        let sep = findFrameEnd(buffer);
        while (sep !== -1) {
            const frame = parseFrame(buffer.slice(0, sep.index));
            buffer = buffer.slice(sep.index + sep.length);
            if (frame) yield frame;
            sep = findFrameEnd(buffer);
        }
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
}
