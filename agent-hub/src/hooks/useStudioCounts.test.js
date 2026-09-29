import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

import { notifyManager } from '@tanstack/react-query';
import { useStudioCounts, parseStudioCounts, countFor, STUDIO_COUNTS_POLL_MS } from './useStudioCounts';
import { queryClient } from '../api/queryClient';
import { queryWrapper } from '../test/queryWrapper';

const ok = (body) => ({ ok: true, json: async () => body });

// The app's own client, so the poll, the staleness window and the focus
// gating are the ones the rail really runs with.
const wrapper = queryWrapper(queryClient);

// React Query hands its updates over through setTimeout(0), which a fake
// clock never fires by itself. A microtask keeps them flowing under
// vi.useFakeTimers without advancing the clock the test is reasoning about.
notifyManager.setScheduler(queueMicrotask);

const setVisibility = (state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

// A real `visibilitychange` is fired at the Document and BUBBLES, which is how
// it reaches the window listener the data layer subscribes through. jsdom
// gives a non-bubbling event unless you ask.
const fireVisibilityChange = () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));

// A resolved fetch reaches the hook through the query cache's notify queue, so
// one microtask is not always enough to see it in `result.current`.
const flush = () => act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
});

describe('parseStudioCounts / countFor', () => {
    it('keeps finite numbers only and reads makers', () => {
        expect(parseStudioCounts({ counts: { automations: 9, apps: '4', skills: NaN, knowledge: 0 }, makers: 12 }))
            .toEqual({ counts: { automations: 9, knowledge: 0 }, makers: 12 });
        // A body that PARSES to nothing is still an answer that arrived — that
        // is what tells it apart from a read that never landed, which is now
        // the difference between a resolved query and a rejected one.
        expect(parseStudioCounts({})).toEqual({ counts: null, makers: null });
        expect(parseStudioCounts(null)).toEqual({ counts: null, makers: null });
    });

    it('countFor is undefined for an omitted key — the row renders no number', () => {
        const counts = { automations: 9 };
        expect(countFor(counts, 'automations')).toBe(9);
        expect(countFor(counts, 'apps')).toBeUndefined();
        expect(countFor(null, 'apps')).toBeUndefined();
    });
});

describe('useStudioCounts', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        fetchMock.mockReset();
        queryClient.clear();
        setVisibility('visible');
        fireVisibilityChange();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('fetches once on mount and exposes the parsed counts', async () => {
        fetchMock.mockResolvedValue(ok({ counts: { automations: 9, skills: 7 }, makers: 3 }));
        const { result } = renderHook(() => useStudioCounts(), { wrapper });
        expect(result.current).toEqual({ counts: null, makers: null, failed: false });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/studio/counts');
        expect(result.current).toEqual({ counts: { automations: 9, skills: 7 }, makers: 3, failed: false });
    });

    it('polls every 30s', async () => {
        fetchMock.mockResolvedValue(ok({ counts: {}, makers: 0 }));
        renderHook(() => useStudioCounts(), { wrapper });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(STUDIO_COUNTS_POLL_MS); });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('skips the fetch while the tab is hidden and catches up on visibilitychange', async () => {
        fetchMock.mockResolvedValue(ok({ counts: { apps: 4 }, makers: 1 }));
        setVisibility('hidden');
        const { result } = renderHook(() => useStudioCounts(), { wrapper });
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(STUDIO_COUNTS_POLL_MS); });
        expect(fetchMock).not.toHaveBeenCalled();
        setVisibility('visible');
        await act(async () => {
            fireVisibilityChange();
            await Promise.resolve();
        });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.counts).toEqual({ apps: 4 });
    });

    it('a failed response leaves the counts absent, never throws — and SAYS it failed', async () => {
        // `counts: null` alone cannot be read as "not in yet": a screen that
        // does not poll (Studio Home's map) would then wait forever for a
        // number that is not coming. `failed` is the difference.
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        const { result } = renderHook(() => useStudioCounts(), { wrapper });
        await flush();
        expect(result.current).toEqual({ counts: null, makers: null, failed: true });
        fetchMock.mockRejectedValue(new Error('offline'));
        await act(async () => { vi.advanceTimersByTime(STUDIO_COUNTS_POLL_MS); });
        await flush();
        expect(result.current).toEqual({ counts: null, makers: null, failed: true });
    });

    it('a read that lands again clears the failure — a hiccup does not stick', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        const { result } = renderHook(() => useStudioCounts(), { wrapper });
        await flush();
        expect(result.current.failed).toBe(true);
        fetchMock.mockResolvedValue(ok({ counts: { apps: 2 }, makers: 1 }));
        await act(async () => { vi.advanceTimersByTime(STUDIO_COUNTS_POLL_MS); await Promise.resolve(); });
        await flush();
        expect(result.current).toEqual({ counts: { apps: 2 }, makers: 1, failed: false });
    });

    it('enabled: false polls nothing and clears what it had', async () => {
        fetchMock.mockResolvedValue(ok({ counts: { apps: 4 }, makers: 1 }));
        const { result, rerender } = renderHook(({ enabled }) => useStudioCounts({ enabled }), { wrapper, initialProps: { enabled: true } });
        await flush();
        expect(result.current.counts).toEqual({ apps: 4 });
        rerender({ enabled: false });
        expect(result.current).toEqual({ counts: null, makers: null, failed: false });
        await act(async () => { vi.advanceTimersByTime(STUDIO_COUNTS_POLL_MS * 2); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('poll: false reads once and never sets a timer', async () => {
        // Studio's Start screen: the rail is already polling this endpoint,
        // and a second timer on the same tab would ask twice for one number.
        fetchMock.mockResolvedValue(ok({ counts: { apps: 4 }, makers: 12 }));
        const { result } = renderHook(() => useStudioCounts({ poll: false }), { wrapper });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.makers).toBe(12);
        await act(async () => { vi.advanceTimersByTime(STUDIO_COUNTS_POLL_MS * 4); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('poll: false still catches up when the tab becomes visible', async () => {
        // Its ONE fetch returns early in a hidden tab, so without the catch-up
        // a screen opened in a background tab would never get a number at all.
        fetchMock.mockResolvedValue(ok({ counts: { apps: 4 }, makers: 12 }));
        setVisibility('hidden');
        const { result } = renderHook(() => useStudioCounts({ poll: false }), { wrapper });
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        setVisibility('visible');
        await act(async () => {
            fireVisibilityChange();
            await Promise.resolve();
        });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.makers).toBe(12);
    });

    it('stops polling on unmount', async () => {
        fetchMock.mockResolvedValue(ok({ counts: {}, makers: 0 }));
        const { unmount } = renderHook(() => useStudioCounts(), { wrapper });
        await flush();
        unmount();
        await act(async () => { vi.advanceTimersByTime(STUDIO_COUNTS_POLL_MS * 2); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
