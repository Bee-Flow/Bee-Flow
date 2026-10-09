import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDemoTransport } from '../utils/helpers';
import useDocumentStream from './useDocumentStream';

/** The document's live channel: frames in, handlers by event type, reconnect, close. */

const enc = new TextEncoder();

describe('useDocumentStream', () => {
    let opens: Array<{ url: string; push: (f: string) => void; end: () => void; signal?: AbortSignal | null }> = [];
    let status = 200;

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        opens = [];
        status = 200;
        setDemoTransport(async (url: string, init: RequestInit = {}) => {
            if (status !== 200) return new Response('no', { status });
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
            opens.push({ url, push: (f) => controller.enqueue(enc.encode(f)), end: () => controller.close(), signal: init.signal });
            return new Response(body, { status: 200 });
        });
    });
    afterEach(() => { setDemoTransport(null); vi.useRealTimers(); });

    const frame = (kind: string, data: unknown) => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    it('delivers an event to the handlers of its type, and unsubscribes', async () => {
        const { result, unmount } = renderHook(() => useDocumentStream('d1'));
        await tick(50);
        expect(opens[0].url).toContain('/api/studio-documents/d1/stream');
        const presence = vi.fn();
        const other = vi.fn();
        const off = result.current.subscribe('document.presence', presence);
        result.current.subscribe('sheet.cell', other);
        await act(async () => { opens[0].push(frame('ready', { since: 0 })); opens[0].push(frame('document.presence', { actorId: 'bob' })); await vi.advanceTimersByTimeAsync(50); });
        expect(presence).toHaveBeenCalledWith({ actorId: 'bob' });
        expect(other).not.toHaveBeenCalled();
        off();
        await act(async () => { opens[0].push(frame('document.presence', { actorId: 'cas' })); await vi.advanceTimersByTimeAsync(50); });
        expect(presence).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('reconnects with backoff after the stream ends', async () => {
        const { unmount } = renderHook(() => useDocumentStream('d1'));
        await tick(50);
        await act(async () => { opens[0].end(); await vi.advanceTimersByTimeAsync(50); });
        expect(opens).toHaveLength(1);
        await tick(1500);
        expect(opens).toHaveLength(2);
        unmount();
    });

    it('closes on unmount and never opens while disabled', async () => {
        const off = renderHook(() => useDocumentStream('d1', false));
        await tick(50);
        expect(opens).toHaveLength(0);
        off.unmount();
        const { unmount } = renderHook(() => useDocumentStream('d1'));
        await tick(50);
        unmount();
        expect(opens[0].signal?.aborted).toBe(true);
        await tick(5000);
        expect(opens).toHaveLength(1);
    });

    it('stops for good on forbidden and on a 404', async () => {
        const { result, unmount } = renderHook(() => useDocumentStream('d1'));
        await tick(50);
        const forbidden = vi.fn();
        result.current.subscribe('forbidden', forbidden);
        await act(async () => { opens[0].push(frame('forbidden', { reason: 'access_revoked' })); await vi.advanceTimersByTimeAsync(50); });
        expect(forbidden).toHaveBeenCalled();
        await tick(5000);
        expect(opens).toHaveLength(1);
        unmount();

        status = 404;
        const again = renderHook(() => useDocumentStream('gone'));
        await tick(5000);
        expect(opens).toHaveLength(1);
        again.unmount();
    });
});
