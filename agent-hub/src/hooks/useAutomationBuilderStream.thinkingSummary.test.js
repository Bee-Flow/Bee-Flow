import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * The `thinking_summary` SSE event: the server's narrator sends one short
 * phrase about the model's current reasoning, and the client pins it on the
 * in-flight assistant message as `thinkingSummary`. Two things are worth a
 * test here. The field is written copy-on-write while every neighbouring case
 * mutates the message in place — a consumer memoing on `last.thinkingSummary`
 * depends on that. And `seq` guards against a late, older summary overwriting
 * a newer one: the narrator answers about a window of text, and a slow answer
 * about an old window must not win.
 */

const enc = new TextEncoder();
const sse = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// A body the test feeds one chunk at a time, so state can be inspected between
// events exactly as React sees them — one SSE line, one setState.
function openBody() {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    return {
        stream,
        push: (chunk) => controller.enqueue(chunk),
        close: () => controller.close(),
    };
}

// The reader loop is all microtasks; one macrotask lets it take the chunk,
// run handle() and land the setState inside the surrounding act().
const flush = () => new Promise((r) => setTimeout(r, 0));

const lastMsg = (result) => result.current.state.messages[result.current.state.messages.length - 1];

async function startTurn() {
    const body = openBody();
    authFetch.mockResolvedValue({ ok: true, status: 200, body: body.stream });
    const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
    let sending;
    await act(async () => {
        sending = result.current.send({ message: 'x' });
        await flush();
    });
    return { result, body, finish: async () => {
        await act(async () => {
            body.push(sse('done', {}));
            body.close();
            await sending;
        });
    } };
}

describe('useAutomationBuilderStream — thinking_summary', () => {
    beforeEach(() => {
        authFetch.mockReset();
    });

    it('pins the narrated phrase on the assistant message, copy-on-write, and ignores a stale seq', async () => {
        const { result, body, finish } = await startTurn();
        expect(result.current.state.messages).toHaveLength(2);
        expect(result.current.state.running).toBe(true);
        const userMsg = result.current.state.messages[0];
        expect(userMsg.role).toBe('user');

        await act(async () => {
            body.push(sse('thinking_start', { partId: 'p1' }));
            body.push(sse('thinking_summary', { partId: 'p1', text: 'Choosing the schedule', seq: 1 }));
            await flush();
        });
        const afterFirst = lastMsg(result);
        expect(afterFirst.role).toBe('assistant');
        expect(afterFirst.thinkingSummary).toMatchObject({ text: 'Choosing the schedule', partId: 'p1', seq: 1 });
        expect(typeof afterFirst.thinkingSummary.at).toBe('number');
        // The thinking part itself is untouched by the summary.
        expect(afterFirst.thinkingParts.map(p => p.id)).toEqual(['p1']);

        await act(async () => {
            body.push(sse('thinking_summary', { partId: 'p1', text: 'Wiring the error branch', seq: 2 }));
            await flush();
        });
        const afterSecond = lastMsg(result);
        expect(afterSecond.thinkingSummary.text).toBe('Wiring the error branch');
        expect(afterSecond.thinkingSummary.seq).toBe(2);
        // Copy-on-write: a memo keyed on the message (or on the field) must see
        // a new reference for each phrase. Nothing but the summary changed
        // between these two reads, so this is the write itself being tested.
        expect(afterSecond).not.toBe(afterFirst);
        expect(afterSecond.thinkingSummary).not.toBe(afterFirst.thinkingSummary);
        // …while the user turn is left alone.
        expect(result.current.state.messages[0]).toBe(userMsg);

        // A slow narrator answer about an older window arrives late.
        await act(async () => {
            body.push(sse('thinking_summary', { partId: 'p1', text: 'Choosing the schedule', seq: 1 }));
            await flush();
        });
        expect(lastMsg(result).thinkingSummary).toMatchObject({ text: 'Wiring the error branch', seq: 2 });
        // Ignored means ignored: no fresh copy for a no-op.
        expect(lastMsg(result)).toBe(afterSecond);

        await finish();
        expect(result.current.state.running).toBe(false);
        // The phrase survives the stream ending — the duration label takes
        // over in the UI, but the field stays on the message.
        expect(lastMsg(result)).toMatchObject({ isStreaming: false, thinkingSummary: { seq: 2 } });
    });

    it('coerces a sparse event to the documented shape and lets an equal seq through', async () => {
        const { result, body, finish } = await startTurn();

        await act(async () => {
            body.push(sse('thinking_summary', { partId: 'p1' }));
            await flush();
        });
        expect(lastMsg(result).thinkingSummary).toMatchObject({ text: '', partId: 'p1', seq: 0 });

        await act(async () => {
            body.push(sse('thinking_summary', { text: 'Checking the response shape', seq: 3 }));
            await flush();
        });
        expect(lastMsg(result).thinkingSummary).toMatchObject({ text: 'Checking the response shape', partId: null, seq: 3 });

        // Only a strictly HIGHER existing seq blocks; a re-sent same-seq phrase
        // (a corrected wording) is accepted.
        await act(async () => {
            body.push(sse('thinking_summary', { text: 'Checking the HTTP response', seq: 3 }));
            await flush();
        });
        expect(lastMsg(result).thinkingSummary.text).toBe('Checking the HTTP response');

        await finish();
    });
});
