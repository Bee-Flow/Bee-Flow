import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { renderHookWithClient } from '@/test/render';
import { asResponse, jsonAnswer } from '@/test/http';
import { useNotifications } from './useNotifications';

// The inbox reads through the real request layer; only the network answers here.
let fetchSpy: MockInstance<typeof fetch>;
let unread = 0;
let list: { id: string; read: boolean }[] = [];

const callsTo = (path: string) => fetchSpy.mock.calls.filter(([url]) => String(url).includes(path)).length;

beforeEach(() => {
    unread = 0;
    list = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/api/notifications/unread-count')) return asResponse(jsonAnswer({ count: unread }));
        if (u.includes('/api/notifications')) return asResponse(jsonAnswer({ notifications: list }));
        return asResponse(jsonAnswer({}));
    });
});

afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
});

describe('useNotifications', () => {
    it('reads the list and the unread count on mount, and counts the unread rows', async () => {
        list = [{ id: 'a', read: false }, { id: 'b', read: true }];
        unread = 1;
        const { result } = renderHookWithClient(() => useNotifications());
        await waitFor(() => expect(result.current.notifications).toHaveLength(2));
        expect(result.current.unreadCount).toBe(1);
        expect(callsTo('/api/notifications/unread-count')).toBe(1);
    });

    it('reads the list again when the polled count grows, and not when it stays the same', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { result } = renderHookWithClient(() => useNotifications());
        await waitFor(() => expect(callsTo('/api/notifications/unread-count')).toBe(1));
        await waitFor(() => expect(callsTo('/api/notifications?limit=30')).toBe(1));

        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await waitFor(() => expect(callsTo('/api/notifications/unread-count')).toBe(2));
        expect(callsTo('/api/notifications?limit=30')).toBe(1);

        list = [{ id: 'n', read: false }];
        unread = 1;
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await waitFor(() => expect(callsTo('/api/notifications?limit=30')).toBe(2));
        await waitFor(() => expect(result.current.notifications).toEqual(list));
        expect(result.current.unreadCount).toBe(1);
    });
});
