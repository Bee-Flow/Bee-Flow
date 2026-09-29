import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper, testQueryClient } from '../test/queryWrapper';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

import { useSkills } from './useSkills';

/**
 * The list moved out of a module-level `let cache` (plus a Set of listeners)
 * into the shared React Query cache. What has to stay true:
 *
 *   - two mounted copies read ONE list and cost one request;
 *   - a write refreshes that one list for all of them;
 *   - a feature that is switched off (403/404) reads as "no skills", not as
 *     an error on screen;
 *   - a real failure says so.
 *
 * And what the move BUYS: the cache is the one `AuthedApp` clears on logout,
 * so the next account on a shared browser can no longer read the previous
 * one's skills.
 */

const json = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
});

beforeEach(() => {
    vi.clearAllMocks();
});

describe('useSkills', () => {
    it('hands over the list once it arrives', async () => {
        fetchMock.mockImplementation(async () => json([{ id: 's1', name: 'Summarise' }]));
        const { result } = renderHook(() => useSkills(), { wrapper: queryWrapper() });

        expect(result.current.skills).toEqual([]);
        await waitFor(() => expect(result.current.skills).toHaveLength(1));
        expect(result.current.skills[0].name).toBe('Summarise');
        expect(result.current.error).toBeNull();
    });

    it('costs ONE request for two mounted copies', async () => {
        fetchMock.mockImplementation(async () => json([{ id: 's1' }]));
        const client = testQueryClient();
        const first = renderHook(() => useSkills(), { wrapper: queryWrapper(client) });
        const second = renderHook(() => useSkills(), { wrapper: queryWrapper(client) });

        await waitFor(() => expect(first.result.current.skills).toHaveLength(1));
        await waitFor(() => expect(second.result.current.skills).toHaveLength(1));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reads a switched-off feature as an empty list, not as an error', async () => {
        fetchMock.mockImplementation(async () => json({ error: 'forbidden' }, 403));
        const { result } = renderHook(() => useSkills(), { wrapper: queryWrapper() });

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.skills).toEqual([]);
        expect(result.current.error).toBeNull();
    });

    it('says so when the list cannot be read', async () => {
        fetchMock.mockImplementation(async () => json({ error: 'boom' }, 500));
        const { result } = renderHook(() => useSkills(), { wrapper: queryWrapper() });

        await waitFor(() => expect(result.current.error).toBe('Failed to load skills'));
        expect(result.current.skills).toEqual([]);
    });

    it('re-reads the list after a create, and surfaces the server’s refusal', async () => {
        fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (opts?.method === 'POST') return json({ id: 's2', name: 'New' }, 201);
            return json([{ id: 's1' }]);
        });
        const { result } = renderHook(() => useSkills(), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.skills).toHaveLength(1));

        fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (opts?.method === 'POST') return json({ id: 's2', name: 'New' }, 201);
            return json([{ id: 's1' }, { id: 's2', name: 'New' }]);
        });
        await act(async () => { await result.current.create({ name: 'New' }); });
        await waitFor(() => expect(result.current.skills).toHaveLength(2));

        fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) => {
            if (opts?.method === 'POST') return json({ error: 'name taken' }, 400);
            return json([]);
        });
        await expect(result.current.create({ name: 'New' })).rejects.toThrow('name taken');
    });

    it('re-reads the list after an update and after a delete', async () => {
        fetchMock.mockImplementation(async () => json([{ id: 's1' }]));
        const { result } = renderHook(() => useSkills(), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.skills).toHaveLength(1));

        const listCalls = () => fetchMock.mock.calls.filter(([, opts]) => !opts || !opts.method || opts.method === 'GET').length;
        const before = listCalls();
        await act(async () => { await result.current.update('s1', { name: 'Renamed' }); });
        expect(listCalls()).toBeGreaterThan(before);

        const afterUpdate = listCalls();
        await act(async () => { await result.current.remove('s1'); });
        expect(listCalls()).toBeGreaterThan(afterUpdate);
    });
});
