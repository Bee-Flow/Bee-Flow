import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * The composer's stop button, for the automation builder.
 *
 * It has always been rendered (InputArea shows it whenever `isLoading`), and
 * its handler was an empty function: `() => { /* SSE abort happens
 * automatically when send is re-issued *\/ }`. So the build was abandoned when
 * the user sent their NEXT message, not when they pressed stop — and on a
 * single-slot local model that means the next message waits for the answer
 * nobody wanted.
 *
 * `stop` aborts the fetch. The route turns that close into an abort of the
 * request in flight to the model (chatStream.js), so the slot frees at once.
 */

const enc = new TextEncoder();
const sse = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const flush = () => new Promise((r) => setTimeout(r, 0));

function openBody() {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    return { stream, push: (c) => controller.enqueue(c), close: () => controller.close() };
}

describe('useAutomationBuilderStream.stop', () => {
    let seenSignal;
    beforeEach(() => {
        seenSignal = null;
        authFetch.mockReset();
    });

    async function startBuilding() {
        const body = openBody();
        authFetch.mockImplementation(async (url, opts) => {
            seenSignal = opts?.signal || null;
            return { ok: true, status: 200, body: body.stream };
        });
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        await act(async () => { result.current.send({ message: 'build it', modelTier: 'fast' }); await flush(); });
        await act(async () => { body.push(sse('message', { content: 'working' })); await flush(); });
        return { result, body };
    }

    it('is exported — the button has something to call', () => {
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        expect(typeof result.current.stop).toBe('function');
    });

    it('aborts the request in flight and settles the turn', async () => {
        const { result } = await startBuilding();
        expect(result.current.state.running).toBe(true);
        expect(seenSignal?.aborted).toBe(false);

        await act(async () => { result.current.stop(); await flush(); });

        expect(seenSignal.aborted).toBe(true);
        expect(result.current.state.running).toBe(false);
        expect(result.current.state.toolDraft).toBe(null);
    });

    it('leaves no message pulsing as if it were still being written', async () => {
        const { result } = await startBuilding();
        await act(async () => { result.current.stop(); await flush(); });
        expect(result.current.state.messages.some((m) => m.isStreaming)).toBe(false);
    });

    it('a stop with nothing running changes nothing', () => {
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        const before = result.current.state;
        act(() => { result.current.stop(); });
        expect(result.current.state.running).toBe(false);
        expect(result.current.state).toBe(before);
    });

    it('a stopped build is not reported to the user as an error', async () => {
        const { result } = await startBuilding();
        await act(async () => { result.current.stop(); await flush(); });
        expect(result.current.state.error).toBe(null);
    });
});
