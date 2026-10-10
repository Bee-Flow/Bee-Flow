import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRecentMemories } from '../components/chat/memory/memoryApi';
import useRememberedMemories from './useRememberedMemories';

vi.mock('../components/chat/memory/memoryApi', () => ({ fetchRecentMemories: vi.fn() }));

const fetchRecent = vi.mocked(fetchRecentMemories);
const SINCE = '2026-10-10T10:00:00.000Z';
const MEMORY = { id: 'm1', type: 'fact', content: 'Lives in Utrecht' };

beforeEach(() => { vi.useFakeTimers(); fetchRecent.mockReset(); fetchRecent.mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); });

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useRememberedMemories', () => {
    it('asks at 2 s, 6 s and 15 s and then gives up', async () => {
        const { result } = renderHook(() => useRememberedMemories({ conversationId: 'c1', since: SINCE, enabled: true }));
        expect(fetchRecent).not.toHaveBeenCalled();
        await tick(2000);
        expect(fetchRecent).toHaveBeenCalledTimes(1);
        expect(fetchRecent).toHaveBeenLastCalledWith('c1', SINCE, expect.any(AbortSignal));
        await tick(3999);
        expect(fetchRecent).toHaveBeenCalledTimes(1);
        await tick(1);
        expect(fetchRecent).toHaveBeenCalledTimes(2);
        await tick(9000);
        expect(fetchRecent).toHaveBeenCalledTimes(3);
        await tick(60000);
        expect(fetchRecent).toHaveBeenCalledTimes(3);
        expect(result.current.items).toEqual([]);
        expect(result.current.done).toBe(true);
    });

    it('stops at the first non-empty answer', async () => {
        fetchRecent.mockResolvedValueOnce([]).mockResolvedValueOnce([MEMORY]);
        const { result } = renderHook(() => useRememberedMemories({ conversationId: 'c1', since: SINCE, enabled: true }));
        await tick(6000);
        expect(result.current.items).toEqual([MEMORY]);
        await tick(60000);
        expect(fetchRecent).toHaveBeenCalledTimes(2);
    });

    it('a failed lookup counts as nothing yet and the next one still runs', async () => {
        fetchRecent.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([MEMORY]);
        const { result } = renderHook(() => useRememberedMemories({ conversationId: 'c1', since: SINCE, enabled: true }));
        await tick(6000);
        expect(result.current.items).toEqual([MEMORY]);
    });

    it('does not ask at all when disabled or without a conversation', async () => {
        renderHook(() => useRememberedMemories({ conversationId: 'c1', since: SINCE, enabled: false }));
        renderHook(() => useRememberedMemories({ conversationId: null, since: SINCE, enabled: true }));
        await tick(60000);
        expect(fetchRecent).not.toHaveBeenCalled();
    });

    it('leaving the conversation cancels what is pending', async () => {
        const { unmount } = renderHook(() => useRememberedMemories({ conversationId: 'c1', since: SINCE, enabled: true }));
        await tick(2000);
        expect(fetchRecent).toHaveBeenCalledTimes(1);
        unmount();
        await tick(60000);
        expect(fetchRecent).toHaveBeenCalledTimes(1);
    });

    it('a new turn stops the previous turn polling and ignores memories created after it started', async () => {
        const UNTIL = '2026-10-10T10:00:10.000Z';
        const late = { ...MEMORY, id: 'm9', created_at: '2026-10-10T10:00:12.000Z' };
        const early = { ...MEMORY, id: 'm8', created_at: '2026-10-10T10:00:05.000Z' };
        fetchRecent.mockResolvedValue([early, late]);
        const { result, rerender } = renderHook(
            (p: { until?: string }) => useRememberedMemories({ conversationId: 'c1', since: SINCE, until: p.until, enabled: true }),
            { initialProps: {} as { until?: string } },
        );
        await tick(1000);
        // Turn two starts before the first poll fired: polling for turn one stops.
        rerender({ until: UNTIL });
        await tick(60000);
        expect(fetchRecent).not.toHaveBeenCalled();
        expect(result.current.items).toEqual([]);
    });

    it('items found for a turn are filtered to the ones created before the next turn', async () => {
        const late = { ...MEMORY, id: 'm9', created_at: '2026-10-10T10:00:12.000Z' };
        const early = { ...MEMORY, id: 'm8', created_at: '2026-10-10T10:00:05.000Z' };
        fetchRecent.mockResolvedValue([early, late]);
        const { result, rerender } = renderHook(
            (p: { until?: string }) => useRememberedMemories({ conversationId: 'c1', since: SINCE, until: p.until, enabled: true }),
            { initialProps: {} as { until?: string } },
        );
        await tick(2000);
        expect(result.current.items.map((i) => i.id)).toEqual(['m8', 'm9']);
        rerender({ until: '2026-10-10T10:00:10.000Z' });
        expect(result.current.items.map((i) => i.id)).toEqual(['m8']);
    });
});
