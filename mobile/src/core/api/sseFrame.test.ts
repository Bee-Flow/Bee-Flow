/**
 * The SSE framer on its own, without a transport. sse.test.ts drives the same
 * code through a mocked fetch; these pin the pieces directly, because every
 * stream in the app — voice included — now goes through them.
 */

import { findFrameEnd, parseFrame, readFrames, type SseFrame } from './sseFrame';

function readerOf(chunks: string[]) {
    const encoder = new TextEncoder();
    let i = 0;
    return {
        read: async () =>
            i < chunks.length
                ? { done: false, value: encoder.encode(chunks[i++] as string) }
                : { done: true, value: undefined },
    };
}

async function framesOf(chunks: string[]): Promise<SseFrame[]> {
    const out: SseFrame[] = [];
    for await (const frame of readFrames(readerOf(chunks), () => {})) out.push(frame);
    return out;
}

describe('findFrameEnd', () => {
    it('finds a blank line in either line-ending style, whichever comes first', () => {
        expect(findFrameEnd('a\n\nb')).toEqual({ index: 1, length: 2 });
        expect(findFrameEnd('a\r\n\r\nb')).toEqual({ index: 1, length: 4 });
        expect(findFrameEnd('a\r\n\r\nb\n\nc')).toEqual({ index: 1, length: 4 });
        expect(findFrameEnd('a\n\nb\r\n\r\n')).toEqual({ index: 1, length: 2 });
    });

    it('answers -1 while a frame is still incomplete', () => {
        expect(findFrameEnd('event: content\ndata: {"t')).toBe(-1);
    });
});

describe('parseFrame', () => {
    it('reads the event name and the JSON payload', () => {
        expect(parseFrame('event: content\ndata: {"text":"hi"}')).toEqual({ event: 'content', data: { text: 'hi' } });
    });

    it('defaults the event to message and keeps non-JSON data as text', () => {
        expect(parseFrame('data: <html>')).toEqual({ event: 'message', data: '<html>' });
    });

    it('produces nothing for a comment or an empty frame', () => {
        expect(parseFrame(': ping')).toBeNull();
        expect(parseFrame('   ')).toBeNull();
        expect(parseFrame('event: done')).toBeNull();
    });

    it('treats only one leading space as part of the delimiter', () => {
        expect(parseFrame('data:  ab')).toEqual({ event: 'message', data: ' ab' });
        expect(parseFrame('data:ab')).toEqual({ event: 'message', data: 'ab' });
    });

    it('joins multi-line data with newlines', () => {
        expect(parseFrame('data: a\ndata: b')).toEqual({ event: 'message', data: 'a\nb' });
    });
});

describe('readFrames', () => {
    it('yields a frame split across chunks, and the tail with no blank line', async () => {
        const frames = await framesOf(['event: con', 'tent\ndata: {"text":"a"}\n', '\nevent: done\ndata: {}']);
        expect(frames).toEqual([
            { event: 'content', data: { text: 'a' } },
            { event: 'done', data: {} },
        ]);
    });

    it('reports every chunk to the idle timer', async () => {
        const onChunk = jest.fn();
        for await (const frame of readFrames(readerOf(['data: 1\n\n', ': ping\n\n']), onChunk)) void frame;
        expect(onChunk).toHaveBeenCalledTimes(2);
    });
});
