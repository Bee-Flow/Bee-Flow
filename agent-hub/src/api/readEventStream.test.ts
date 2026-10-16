// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readEventStream, readSseFrames, readSseLines, type SseMessage } from './readEventStream';

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
            else controller.close();
        },
    });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
}

describe('readEventStream: parsing', () => {
    it('yields one parsed event per data line, in order', async () => {
        const body = streamFrom([
            'event: phase\ndata: {"phase":"scanning"}\n\n',
            'event: done\ndata: {"ok":true}\n\n',
        ]);
        expect(await collect(readEventStream(body))).toEqual([
            { event: 'phase', data: { phase: 'scanning' } },
            { event: 'done', data: { ok: true } },
        ]);
    });

    it('reads a Response as well as a bare body', async () => {
        const res = new Response(streamFrom(['event: a\ndata: 1\n\n']));
        expect(await collect(readEventStream(res))).toEqual([{ event: 'a', data: 1 }]);
    });

    it('reassembles lines split across chunks, including a split multi-byte character', async () => {
        const enc = new TextEncoder();
        const bytes = enc.encode('event: done\ndata: {"t":"é"}\n\n');
        const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte é
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(c) {
                if (sent === 0) c.enqueue(bytes.slice(0, cut));
                else if (sent === 1) c.enqueue(bytes.slice(cut));
                else c.close();
                sent += 1;
            },
        });
        expect(await collect(readEventStream(body))).toEqual([{ event: 'done', data: { t: 'é' } }]);
    });

    it('accepts CRLF framing and no space after the colon', async () => {
        const body = streamFrom(['event:content\r\ndata:{"c":"x"}\r\n\r\n']);
        expect(await collect(readEventStream(body))).toEqual([{ event: 'content', data: { c: 'x' } }]);
    });

    it('flushes a terminal event that has no trailing newline', async () => {
        const body = streamFrom(['event: done\ndata: {"end":1}']);
        expect(await collect(readEventStream(body))).toEqual([{ event: 'done', data: { end: 1 } }]);
    });

    it('keeps the last event name for a following data line, and uses defaultEvent before any', async () => {
        const body = streamFrom(['data: 1\n\nevent: x\ndata: 2\n\ndata: 3\n\n']);
        expect(await collect(readEventStream(body))).toEqual([
            { event: 'message', data: 1 },
            { event: 'x', data: 2 },
            { event: 'x', data: 3 },
        ]);
        const again = streamFrom(['data: 1\n\n']);
        expect(await collect(readEventStream(again, { defaultEvent: '' }))).toEqual([{ event: '', data: 1 }]);
    });

    it('skips data that is not JSON and reports it', async () => {
        const onInvalidData = vi.fn();
        const body = streamFrom(['event: a\ndata: {broken\n\n: comment\nid: 7\nevent: b\ndata: {"ok":1}\n\n']);
        expect(await collect(readEventStream(body, { onInvalidData }))).toEqual([{ event: 'b', data: { ok: 1 } }]);
        expect(onInvalidData).toHaveBeenCalledTimes(1);
        expect(onInvalidData.mock.calls[0][0]).toBe('a');
        expect(onInvalidData.mock.calls[0][1]).toBe('{broken');
    });

    it('types the data with the generic', async () => {
        const body = streamFrom(['event: a\ndata: {"n":2}\n\n']);
        const seen: SseMessage<{ n: number }>[] = await collect(readEventStream<{ n: number }>(body));
        expect(seen[0].data.n).toBe(2);
    });
});

describe('readEventStream: body, abort and errors', () => {
    it('throws when there is no readable body', async () => {
        await expect(collect(readEventStream(null))).rejects.toThrow(/no readable body/);
        await expect(collect(readEventStream(new Response(null)))).rejects.toThrow(/no readable body/);
    });

    it('throws an AbortError once the signal aborts, and cancels the reader', async () => {
        const ac = new AbortController();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            pull(c) { c.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\n')); },
            cancel,
        });
        const seen: unknown[] = [];
        const run = (async () => {
            for await (const msg of readEventStream(body, { signal: ac.signal })) {
                seen.push(msg);
                ac.abort();
            }
        })();
        await expect(run).rejects.toMatchObject({ name: 'AbortError' });
        expect(seen).toHaveLength(1);
        await Promise.resolve();
        expect(cancel).toHaveBeenCalled();
    });

    it('cancels the reader when the consumer breaks early', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            pull(c) { c.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\n')); },
            cancel,
        });
        for await (const msg of readEventStream(body)) { void msg; break; }
        await Promise.resolve();
        expect(cancel).toHaveBeenCalled();
    });

    it('propagates a read error', async () => {
        const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error('net down')); } });
        await expect(collect(readEventStream(body))).rejects.toThrow('net down');
    });

    it('works with a minimal fake body that only has getReader().read()', async () => {
        const chunks = [new TextEncoder().encode('event: a\ndata: 1\n')];
        const body = { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }) }) };
        expect(await collect(readEventStream(body as unknown as ReadableStream<Uint8Array>))).toEqual([{ event: 'a', data: 1 }]);
    });
});

describe('readSseLines', () => {
    it('yields decoded lines without CR', async () => {
        expect(await collect(readSseLines(streamFrom(['a\r\nb', '\nc'])))).toEqual(['a', 'b', 'c']);
    });
});

describe('readSseFrames', () => {
    it('yields blank-line separated frames and drops an unterminated last frame', async () => {
        const body = streamFrom(['id: 1\nevent: a\ndata: {}\n\n: ping\n', '\nid: 2\ndata: {"x"', ':1}\n\nevent: half']);
        expect(await collect(readSseFrames(body))).toEqual([
            'id: 1\nevent: a\ndata: {}',
            ': ping',
            'id: 2\ndata: {"x":1}',
        ]);
    });

    it('ignores extra blank lines between frames', async () => {
        expect(await collect(readSseFrames(streamFrom(['data: 1\n\n\n\ndata: 2\n\n'])))).toEqual(['data: 1', 'data: 2']);
    });
});
