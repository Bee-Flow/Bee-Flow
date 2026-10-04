import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Same shape as useExecutions.test.jsx: ONE hoisted api object the mocked hook
// returns, so the hook's effect dependency `api` stays referentially stable and
// re-subscribes only when `enabled`/`automationId` genuinely change.
const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));
vi.mock('../../../../hooks/useAutomationApi', () => ({ default: () => apiMock }));

import useRunStream from './useRunStream';

/**
 * CHARACTERISATION — the live run subscription as it behaves today.
 *
 * The interesting half of this hook is what it does when the connection is
 * NOT healthy: a stream the server closes mid-run, a stream that never
 * connects, a tab that goes away. Those paths are pinned here in detail
 * because they are the ones that decide whether a finished run ever reaches
 * the screen — and today several of them fail quietly. Where the pinned
 * behaviour is a wart, the test name says so.
 */

// A streamRuns that never settles by itself: the test decides when the
// "connection" ends, and how.
function deferredStream() {
    const calls = [];
    const fn = vi.fn((opts) => new Promise((resolve, reject) => {
        calls.push({ ...opts, resolve, reject });
    }));
    return { fn, calls };
}

let hidden = false;
const setHidden = async (value) => {
    hidden = value;
    await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
    });
};

/** Advance fake time (and flush the promise chain) inside act(). */
const tick = async (ms = 0) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

const mount = (props = {}) => {
    const onEvent = vi.fn();
    const view = renderHook(
        (p) => useRunStream(p),
        { initialProps: { enabled: true, automationId: null, onEvent, ...props } },
    );
    return { ...view, onEvent };
};

beforeEach(() => {
    vi.useFakeTimers();
    // Kill the jitter: Math.min(backoff,30000) * (0.7 + 0.5*0.6) === backoff.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    apiMock.listRecentRuns = vi.fn().mockResolvedValue({ runs: [] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ── the healthy path ────────────────────────────────────────────────────────
describe('useRunStream — while the stream is healthy', () => {
    it('reports "paused" and opens nothing when disabled', () => {
        const { fn } = deferredStream();
        apiMock.streamRuns = fn;
        const { result } = mount({ enabled: false });
        expect(result.current.state).toBe('paused');
        expect(fn).not.toHaveBeenCalled();
    });

    it('subscribes immediately for the given automation, with an abort signal, and reports "live"', () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const { result } = mount({ automationId: 'a1' });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(calls[0].automationId).toBe('a1');
        expect(calls[0].signal).toBeInstanceOf(AbortSignal);
        expect(calls[0].signal.aborted).toBe(false);
        expect(result.current.state).toBe('live');
    });

    it('hands every stream event to the caller unchanged', () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const { onEvent } = mount();
        act(() => {
            calls[0].onEvent('step.started', { runId: 'r1', stepId: 's1' });
            calls[0].onEvent('run.finished', { runId: 'r1', status: 'success' });
        });
        expect(onEvent).toHaveBeenCalledTimes(2);
        expect(onEvent).toHaveBeenNthCalledWith(1, 'step.started', { runId: 'r1', stepId: 's1' });
        expect(onEvent).toHaveBeenNthCalledWith(2, 'run.finished', { runId: 'r1', status: 'success' });
    });

    it('adopts a new onEvent identity without tearing the stream down', () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const second = vi.fn();
        const { rerender } = mount();
        rerender({ enabled: true, automationId: null, onEvent: second });
        expect(fn).toHaveBeenCalledTimes(1); // no resubscribe
        act(() => { calls[0].onEvent('run.failed', { runId: 'r9' }); });
        expect(second).toHaveBeenCalledWith('run.failed', { runId: 'r9' });
    });

    it('resubscribes with the new scope when automationId changes', () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const { rerender, onEvent } = mount({ automationId: 'a1' });
        rerender({ enabled: true, automationId: 'a2', onEvent });
        expect(fn).toHaveBeenCalledTimes(2);
        expect(calls[1].automationId).toBe('a2');
        expect(calls[0].signal.aborted).toBe(true); // the old one is cut
    });

    it('aborts the in-flight stream on unmount and stops reconnecting', async () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const { unmount } = mount();
        unmount();
        expect(calls[0].signal.aborted).toBe(true);
        await tick(60_000);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

// ── a stream that stops halfway ─────────────────────────────────────────────
describe('useRunStream — a stream the server closes mid-run', () => {
    it('reconnects after the backoff, and says nothing at all about the gap (wrat)', async () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const { result, onEvent } = mount();

        await act(async () => { calls[0].resolve(); await Promise.resolve(); });
        // Still "live" while nothing is connected — the filter bar's indicator
        // reads this and keeps claiming the list is live.
        expect(result.current.state).toBe('live');
        expect(fn).toHaveBeenCalledTimes(1);

        await tick(1000);
        expect(fn).toHaveBeenCalledTimes(2);
        // No synthetic event, no refetch: whatever the run did during the gap
        // is simply not in the caller's hands.
        expect(onEvent).not.toHaveBeenCalled();
        expect(result.current.state).toBe('live');
    });

    it('a server that accepts and instantly closes loops on SSE forever — polling is never reached (wrat)', async () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const { result } = mount();
        // Only the CATCH path counts failures, so an endlessly closing stream
        // never trips the 3-failure fallback. Backoff still doubles.
        for (const wait of [1000, 2000, 4000, 8000, 16000]) {
            await act(async () => { calls[calls.length - 1].resolve(); await Promise.resolve(); });
            await tick(wait);
        }
        expect(fn).toHaveBeenCalledTimes(6);
        expect(apiMock.listRecentRuns).not.toHaveBeenCalled();
        expect(result.current.state).toBe('live');
    });
});

// ── a stream that never connects ────────────────────────────────────────────
describe('useRunStream — a non-ok response', () => {
    it('retries twice with a doubling backoff, then falls back to polling', async () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const { result } = mount({ automationId: 'a1' });

        const fail = async () => {
            await act(async () => {
                calls[calls.length - 1].reject(Object.assign(new Error('runs stream failed'), { status: 500 }));
                await Promise.resolve();
            });
        };

        await fail();
        expect(result.current.state).toBe('live'); // failure 1 is invisible
        await tick(999);
        expect(fn).toHaveBeenCalledTimes(1);
        await tick(1);
        expect(fn).toHaveBeenCalledTimes(2);

        await fail();
        await tick(1999);
        expect(fn).toHaveBeenCalledTimes(2); // backoff doubled to 2000ms
        await tick(1);
        expect(fn).toHaveBeenCalledTimes(3);

        await fail();
        expect(result.current.state).toBe('polling');
        expect(apiMock.listRecentRuns).toHaveBeenCalledWith({ limit: 25, automationId: 'a1' });
    });

    it('sends automationId: undefined (not null) when the stream is unscoped', async () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        mount({ automationId: null });
        for (let i = 0; i < 3; i += 1) {
            await act(async () => { calls[calls.length - 1].reject(new Error('nope')); await Promise.resolve(); });
            await tick(4000);
        }
        expect(apiMock.listRecentRuns).toHaveBeenCalledWith({ limit: 25, automationId: undefined });
    });
});

// ── the polling fallback ────────────────────────────────────────────────────
describe('useRunStream — the polling fallback', () => {
    const runs = (list) => { apiMock.listRecentRuns = vi.fn().mockResolvedValue({ runs: list }); };

    /** Drop straight into polling: three consecutive stream failures. */
    const intoPolling = async (props = {}) => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const view = mount(props);
        for (let i = 0; i < 3; i += 1) {
            await act(async () => { calls[calls.length - 1].reject(new Error('nope')); await Promise.resolve(); });
            if (i < 2) await tick(4000);
        }
        await tick(0);
        return { ...view, streamFn: fn, streamCalls: calls };
    };

    it('seeds silently on the first tick — no events for runs it is meeting for the first time', async () => {
        runs([{ id: 'r1', status: 'running' }, { id: 'r2', status: 'success' }]);
        const { onEvent, result } = await intoPolling();
        expect(result.current.state).toBe('polling');
        expect(apiMock.listRecentRuns).toHaveBeenCalledTimes(1);
        expect(onEvent).not.toHaveBeenCalled();
    });

    it('emits only for the runs whose status actually moved', async () => {
        runs([{ id: 'r1', status: 'running' }, { id: 'r2', status: 'success' }]);
        const { onEvent } = await intoPolling();
        apiMock.listRecentRuns.mockResolvedValue({
            runs: [{ id: 'r1', status: 'success', automationId: 'a1', durationMs: 900 }, { id: 'r2', status: 'success' }],
        });
        await tick(5000);
        expect(onEvent).toHaveBeenCalledTimes(1);
        expect(onEvent).toHaveBeenCalledWith('run.finished', {
            runId: 'r1', automationId: 'a1', status: 'success', durationMs: 900,
        });
    });

    it('reports a run that ended in error as run.failed', async () => {
        runs([{ id: 'r1', status: 'running' }]);
        const { onEvent } = await intoPolling();
        apiMock.listRecentRuns.mockResolvedValue({ runs: [{ id: 'r1', status: 'error', automationId: 'a1', durationMs: 5 }] });
        await tick(5000);
        expect(onEvent).toHaveBeenCalledWith('run.failed', {
            runId: 'r1', automationId: 'a1', status: 'error', durationMs: 5,
        });
    });

    it('announces a run it has never seen before, once the seed pass is over', async () => {
        runs([{ id: 'r1', status: 'success' }]);
        const { onEvent } = await intoPolling();
        apiMock.listRecentRuns.mockResolvedValue({
            runs: [{ id: 'r2', status: 'running', automationId: 'a1', automationTitle: 'Digest', automationKind: 'automation', triggerKind: 'schedule', startedAt: '2026-09-01T00:00:00.000Z' },
                { id: 'r1', status: 'success' }],
        });
        await tick(5000);
        expect(onEvent).toHaveBeenCalledWith('run.started', {
            runId: 'r2', automationId: 'a1', status: 'running',
            triggerKind: 'schedule', title: 'Digest', kind: 'automation', at: '2026-09-01T00:00:00.000Z',
        });
    });

    it('calls a run that is merely WAITING "finished" (wrat: everything that is not running/queued/error lands here)', async () => {
        runs([{ id: 'r1', status: 'running' }]);
        const { onEvent } = await intoPolling();
        apiMock.listRecentRuns.mockResolvedValue({ runs: [{ id: 'r1', status: 'awaiting_approval', automationId: 'a1' }] });
        await tick(5000);
        expect(onEvent).toHaveBeenCalledWith('run.finished', {
            runId: 'r1', automationId: 'a1', status: 'awaiting_approval', durationMs: undefined,
        });
        expect(onEvent).not.toHaveBeenCalledWith('run.started', expect.anything());
    });

    it('keeps polling after a failed poll', async () => {
        runs([{ id: 'r1', status: 'running' }]);
        const { result } = await intoPolling();
        apiMock.listRecentRuns.mockRejectedValueOnce(new Error('offline'));
        await tick(5000);
        expect(apiMock.listRecentRuns).toHaveBeenCalledTimes(2);
        await tick(5000);
        expect(apiMock.listRecentRuns).toHaveBeenCalledTimes(3);
        expect(result.current.state).toBe('polling');
    });

    it('never climbs back to SSE on its own once it has fallen back (wrat)', async () => {
        runs([]);
        const { streamFn, result } = await intoPolling();
        const before = streamFn.mock.calls.length;
        await tick(120_000);
        expect(streamFn.mock.calls.length).toBe(before);
        expect(result.current.state).toBe('polling');
    });
});

// ── the hidden tab ──────────────────────────────────────────────────────────
describe('useRunStream — pausing on a hidden tab', () => {
    it('aborts the socket and reports "paused" when the tab goes away', async () => {
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        const { result } = mount();
        await setHidden(true);
        expect(calls[0].signal.aborted).toBe(true);
        expect(result.current.state).toBe('paused');
    });

    it('reconnects and reports "live" when the tab comes back', async () => {
        const { fn } = deferredStream();
        apiMock.streamRuns = fn;
        const { result } = mount();
        await setHidden(true);
        await setHidden(false);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(result.current.state).toBe('live');
    });

    it('does not open a stream at all when the tab is already hidden at mount — yet still calls itself "live" (wrat)', () => {
        hidden = true;
        const { fn } = deferredStream();
        apiMock.streamRuns = fn;
        const { result } = mount();
        expect(fn).not.toHaveBeenCalled();
        // …and it still calls itself "live" — nothing is connected. (wrat)
        expect(result.current.state).toBe('live');
    });

    it('leaves a poll loop running ALONGSIDE the new stream when the tab returns mid-poll (wrat)', async () => {
        // The poll tick that was in flight while the tab was hidden reschedules
        // itself on resolve — it checks only `stopped`, never `polling`. So the
        // hook ends up on SSE *and* on a 5s poll it can no longer stop, and the
        // shared `timer` handle now points at the poll, not at the reconnect.
        const { fn, calls } = deferredStream();
        apiMock.streamRuns = fn;
        let releasePoll;
        apiMock.listRecentRuns = vi.fn(() => new Promise((res) => { releasePoll = res; }));

        const { result } = mount();
        for (let i = 0; i < 3; i += 1) {
            await act(async () => { calls[calls.length - 1].reject(new Error('nope')); await Promise.resolve(); });
            if (i < 2) await tick(4000);
        }
        expect(result.current.state).toBe('polling');
        expect(apiMock.listRecentRuns).toHaveBeenCalledTimes(1); // in flight

        await setHidden(true);
        await setHidden(false);
        expect(result.current.state).toBe('live');
        const streamCalls = fn.mock.calls.length;

        // The hidden-tab poll finally answers…
        await act(async () => { releasePoll({ runs: [] }); await Promise.resolve(); });
        await tick(5000);
        // …and the poll loop is alive again, next to the live stream.
        expect(apiMock.listRecentRuns).toHaveBeenCalledTimes(2);
        expect(fn.mock.calls.length).toBe(streamCalls);
        expect(result.current.state).toBe('live');
    });
});
