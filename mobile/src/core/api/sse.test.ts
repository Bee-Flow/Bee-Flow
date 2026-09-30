/**
 * Tests for the SSE reader.
 *
 * Every case here is a real failure mode of Bee Flow's streams rather than a
 * generic spec check:
 *
 *   - The terminal `done` event arrives in the last chunk with NO trailing
 *     blank line. A reader that only emits on a frame separator drops it, the
 *     turn never completes, and the UI shows a spinner forever. This is the
 *     bug the server-side notes call BFSF-177.
 *   - Frames split across chunk boundaries at every possible offset, because a
 *     socket does not respect message boundaries.
 *   - `data:` with no space after the colon. Some intermediaries rewrite it.
 *   - CRLF framing, from proxies that normalise line endings.
 *   - The heartbeat writes BOTH a comment frame (`: ping`) and a real `ping`
 *     event; comments must not produce a frame at all.
 */

import { ApiError, OfflineError, setConnectivity, setUnauthorizedHandler } from './client';
import { setServerUrl } from './server';
import { streamSse } from './sse';

// The test drives the reader by handing it a ReadableStream directly, which is
// exactly what the real expo/fetch returns. The mock's name has to start with
// "mock": jest hoists jest.mock above the const, and only mock-prefixed names
// may be referenced from inside the factory.
const mockExpoFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }));

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(chunks[i] as string));
            i += 1;
        },
    });
}

function respondWith(chunks: string[], init: { ok?: boolean; status?: number } = {}) {
    mockExpoFetch.mockResolvedValueOnce({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        body: streamOf(chunks),
        headers: new Map([['content-type', 'text/event-stream']]),
        json: async () => ({}),
    });
}

/** A stream refused before its first frame, with a JSON body. */
function refuseWith(status: number, body: unknown) {
    mockExpoFetch.mockResolvedValueOnce({
        ok: false,
        status,
        body: null,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => body,
    });
}

/** Run a stream to its end and hand back what it threw. */
async function drain(path: string): Promise<unknown> {
    try {
        for await (const frame of streamSse(path, { body: {} })) {
            throw new Error(`expected no frames, got ${frame.event}`);
        }
    } catch (err) {
        return err;
    }
    return null;
}

async function collect(chunks: string[]) {
    respondWith(chunks);
    const frames = [];
    for await (const frame of streamSse('/ai/chat/direct/stream', { body: {} })) {
        frames.push(frame);
    }
    return frames;
}

beforeAll(async () => {
    await setServerUrl('https://bee.example');
});

beforeEach(() => {
    mockExpoFetch.mockReset();
});

describe('framing', () => {
    it('emits one frame per event', async () => {
        const frames = await collect([
            'event: content\ndata: {"text":"Hello"}\n\n',
            'event: content\ndata: {"text":" world"}\n\n',
            'event: done\ndata: {"conversationId":"c1"}\n\n',
        ]);
        expect(frames.map((f) => f.event)).toEqual(['content', 'content', 'done']);
        expect(frames[0]?.data).toEqual({ text: 'Hello' });
        expect(frames[2]?.data).toEqual({ conversationId: 'c1' });
    });

    /**
     * BFSF-177. The Nextcloud connector frames SSE with `Connection: close` and
     * no Content-Length, and the final event routinely arrives with no trailing
     * newline. Dropping it means the turn never completes.
     */
    it('emits the final event when the stream ends without a trailing blank line', async () => {
        const frames = await collect([
            'event: content\ndata: {"text":"hi"}\n\n',
            'event: done\ndata: {"conversationId":"c1"}',
        ]);
        expect(frames.map((f) => f.event)).toEqual(['content', 'done']);
        expect(frames[1]?.data).toEqual({ conversationId: 'c1' });
    });

    it('reassembles a frame split across chunks at any offset', async () => {
        const whole = 'event: content\ndata: {"text":"abcdef"}\n\n';
        for (let cut = 1; cut < whole.length; cut++) {
            mockExpoFetch.mockReset();
            const frames = await collect([whole.slice(0, cut), whole.slice(cut)]);
            expect(frames).toHaveLength(1);
            expect(frames[0]?.data).toEqual({ text: 'abcdef' });
        }
    });

    it('handles several frames arriving in one chunk', async () => {
        const frames = await collect([
            'event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\nevent: c\ndata: {"n":3}\n\n',
        ]);
        expect(frames.map((f) => f.event)).toEqual(['a', 'b', 'c']);
    });

    it('accepts CRLF framing from a proxy that rewrites line endings', async () => {
        const frames = await collect([
            'event: content\r\ndata: {"text":"crlf"}\r\n\r\n',
            'event: done\r\ndata: {}\r\n\r\n',
        ]);
        expect(frames.map((f) => f.event)).toEqual(['content', 'done']);
        expect(frames[0]?.data).toEqual({ text: 'crlf' });
    });

    it('accepts data: with no space after the colon', async () => {
        const frames = await collect(['event: content\ndata:{"text":"tight"}\n\n']);
        expect(frames[0]?.data).toEqual({ text: 'tight' });
    });

    it('joins a multi-line data payload with newlines', async () => {
        const frames = await collect(['event: note\ndata: line one\ndata: line two\n\n']);
        // Not JSON, so it comes through as text — with the lines preserved.
        expect(frames[0]?.data).toBe('line one\nline two');
    });
});

describe('the heartbeat', () => {
    it('ignores comment frames and still reports the ping event', async () => {
        const frames = await collect([
            ': ping\n\nevent: ping\ndata: {}\n\n',
            'event: done\ndata: {}\n\n',
        ]);
        // The comment produces nothing; the real `ping` event is passed on for
        // the consumer to route to a no-op.
        expect(frames.map((f) => f.event)).toEqual(['ping', 'done']);
    });

    it('produces nothing for a stream of only comments', async () => {
        const frames = await collect([': ping\n\n', ': ping\n\n']);
        expect(frames).toEqual([]);
    });
});

describe('robustness', () => {
    it('defaults the event name to message when the server omits it', async () => {
        const frames = await collect(['data: {"text":"anon"}\n\n']);
        expect(frames[0]?.event).toBe('message');
    });

    it('passes through non-JSON data rather than throwing', async () => {
        // A proxy error page can land mid-stream; it must not take out the
        // reader with a SyntaxError.
        const frames = await collect(['event: error\ndata: <html>502</html>\n\n']);
        expect(frames[0]?.data).toBe('<html>502</html>');
    });

    it('reports a transport failure as being offline when the platform says so', async () => {
        setConnectivity(false);
        try {
            mockExpoFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
            await expect(async () => {
                for await (const frame of streamSse('/ai/chat/direct/stream', { body: {} })) {
                    throw new Error(`expected no frames, got ${frame.event}`);
                }
            }).rejects.toBeInstanceOf(OfflineError);
        } finally {
            setConnectivity(null);
        }
    });

    it('raises the server error when the stream fails before the first frame', async () => {
        mockExpoFetch.mockResolvedValueOnce({
            ok: false,
            status: 402,
            body: null,
            headers: new Map([['content-type', 'application/json']]),
            json: async () => ({ error: 'Monthly message limit reached' }),
        });
        await expect(async () => {
            for await (const frame of streamSse('/ai/chat/direct/stream', { body: {} })) {
                throw new Error(`expected no frames, got ${frame.event}`);
            }
        }).rejects.toThrow('Monthly message limit reached');
    });

    it('shows the human message, not the code, for a training gate', async () => {
        refuseWith(403, {
            error: 'training_required',
            message: 'Finish the course "Agents 101" before using this.',
        });
        const failure = await drain('/agents/a1/chat');
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).message).toBe('Finish the course "Agents 101" before using this.');
        expect((failure as ApiError).code).toBe('training_required');
    });

    /**
     * A session that expires between two chat turns is found out by the
     * stream, not by a list fetch. The stream used to raise it as a plain
     * error, so the person read "Not authenticated" under their message
     * instead of getting the lock screen that would have let them carry on.
     */
    describe('a 401', () => {
        afterEach(() => setUnauthorizedHandler(null));

        it('brings up the lock screen', async () => {
            const handler = jest.fn();
            setUnauthorizedHandler(handler);
            refuseWith(401, { error: 'Not authenticated' });

            const failure = await drain('/ai/chat/direct/stream');
            expect((failure as ApiError).status).toBe(401);
            expect(handler).toHaveBeenCalledWith('/ai/chat/direct/stream');
        });

        it('stays quiet on a path where 401 is the expected answer', async () => {
            const handler = jest.fn();
            setUnauthorizedHandler(handler);
            refuseWith(401, { error: 'Not authenticated' });

            await drain('/auth/some-stream');
            expect(handler).not.toHaveBeenCalled();
        });
    });

    /**
     * Breaking out of the loop must CANCEL the underlying reader, not just stop
     * iterating. Cancelling is what closes the socket, which is what makes the
     * server's res.on('close') fire and abort the model call — without it, a
     * user who leaves the screen keeps burning tokens until the turn finishes
     * on its own.
     *
     * (Aborting mid-stream is not asserted here: a real socket stops
     * delivering, but a ReadableStream built in a test does not honour an
     * AbortSignal, so such a test would only be measuring the mock.)
     */
    it('cancels the reader when the consumer stops early', async () => {
        const cancelled = jest.fn();
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('event: content\ndata: {"text":"one"}\n\n'));
                controller.enqueue(encoder.encode('event: content\ndata: {"text":"two"}\n\n'));
            },
            cancel: cancelled,
        });
        mockExpoFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: stream,
            headers: new Map([['content-type', 'text/event-stream']]),
            json: async () => ({}),
        });

        for await (const frame of streamSse('/ai/chat/direct/stream', { body: {} })) {
            expect(frame.event).toBe('content');
            break;
        }

        expect(cancelled).toHaveBeenCalled();
    });
});
