/**
 * The run-event feed, driven by a fake SSE source.
 *
 * The feed is a notification, not a source of truth, and the hook's job is
 * to keep it connected: route every typed frame to the caller and the status
 * map, ignore frames without a type, reconnect with backoff when the socket
 * drops, open nothing when disabled, and tear the socket down on unmount.
 */

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { useRunStream } from './useRunStream';
import type { SseFrame } from '../../api/sse';

const mockStreamSse = jest.fn();
jest.mock('../../api/sse', () => ({
    streamSse: (...args: unknown[]) => mockStreamSse(...args),
}));

type StreamOpts = { signal: AbortSignal; idleTimeoutMs?: number };

/** A stream that yields the frames, then hangs until the caller aborts. */
function feedOf(frames: SseFrame[]) {
    const signals: AbortSignal[] = [];
    mockStreamSse.mockImplementation(async function* (_path: string, opts: StreamOpts) {
        signals.push(opts.signal);
        for (const frame of frames) yield frame;
        await new Promise<never>((_, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
    });
    return signals;
}

const event = (data: unknown): SseFrame => ({ event: 'message', data });

beforeEach(() => {
    mockStreamSse.mockReset();
    (AppState as { currentState: string }).currentState = 'active';
});

describe('frames', () => {
    it('routes typed frames to the caller and keeps the latest status per run', async () => {
        feedOf([
            event({ type: 'run.started', runId: 'r1', status: 'running' }),
            event({ type: 'step.heartbeat', runId: 'r1' }),
            event({ type: 'run.finished', runId: 'r1', status: 'success' }),
            event({ type: 'run.started', runId: 'r2', status: 'running' }),
            event({ runId: 'r3', status: 'running' }),
            event('not an object'),
        ]);
        const onEvent = jest.fn();
        const { result, unmount } = await renderHook(() => useRunStream({ onEvent }));

        await waitFor(() => expect(result.current.statuses).toEqual({ r1: 'success', r2: 'running' }));

        expect(result.current.connected).toBe(true);
        expect(result.current.last).toEqual({ type: 'run.started', runId: 'r2', status: 'running' });
        expect(onEvent.mock.calls.map((c) => c[0].type)).toEqual([
            'run.started',
            'step.heartbeat',
            'run.finished',
            'run.started',
        ]);
        expect(mockStreamSse).toHaveBeenCalledWith(
            '/api/automation/_runs/stream',
            expect.objectContaining({ idleTimeoutMs: 75_000 }),
        );
        await unmount();
    });

    it('scopes the feed to one automation when asked', async () => {
        feedOf([]);
        const { unmount } = await renderHook(() => useRunStream({ automationId: 'a b' }));
        await waitFor(() => expect(mockStreamSse).toHaveBeenCalled());
        expect(mockStreamSse.mock.calls[0]?.[0]).toBe('/api/automation/_runs/stream?automationId=a%20b');
        await unmount();
    });
});

describe('lifecycle', () => {
    it('opens nothing while disabled', async () => {
        feedOf([]);
        const { result, unmount } = await renderHook(() => useRunStream({ enabled: false }));
        expect(mockStreamSse).not.toHaveBeenCalled();
        expect(result.current.connected).toBe(false);
        await unmount();
    });

    it('aborts the socket on unmount', async () => {
        const signals = feedOf([event({ type: 'run.started', runId: 'r1', status: 'running' })]);
        const { unmount } = await renderHook(() => useRunStream());
        await waitFor(() => expect(signals).toHaveLength(1));

        await unmount();

        expect(signals[0]?.aborted).toBe(true);
    });

    it('reconnects with backoff after the stream ends', async () => {
        jest.useFakeTimers();
        try {
            let opened = 0;
            mockStreamSse.mockImplementation(async function* (_path: string, opts: StreamOpts) {
                opened += 1;
                if (opened === 1) {
                    yield event({ type: 'run.started', runId: 'r1', status: 'running' });
                    return; // the socket closes
                }
                await new Promise<never>((_, reject) => {
                    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
                });
            });
            const { result, unmount } = await renderHook(() => useRunStream());

            // Let the first stream deliver its frame and end.
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(result.current.statuses).toEqual({ r1: 'running' });
            expect(result.current.connected).toBe(false);
            expect(opened).toBe(1);

            // The first retry waits one second; nothing reconnects before that.
            await act(async () => {
                jest.advanceTimersByTime(999);
                await Promise.resolve();
            });
            expect(opened).toBe(1);
            await act(async () => {
                jest.advanceTimersByTime(1);
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(opened).toBe(2);

            await unmount();
        } finally {
            jest.useRealTimers();
        }
    });
});
