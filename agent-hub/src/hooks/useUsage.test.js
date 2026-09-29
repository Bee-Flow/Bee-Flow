import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useUsage, { usageUrl, normaliseUsage, defaultUsageFetcher, USAGE_KIND_PATH } from './useUsage';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * The hook's contract is three states and one fetch:
 *   null  → not loaded (the delete dialog must not read this as "unused")
 *   []    → loaded, nothing depends on it — ALSO after a failed read, with
 *           `error` set, so the dialog never waits on a list that will not come
 *   rows  → loaded
 * and the list is fetched ONCE per (kind, id), however many panels read it.
 */

beforeEach(() => {
    authFetch.mockReset();
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

describe('useUsage — states', () => {
    it('is null before the list arrives and [] once an empty list has', async () => {
        const fetcher = vi.fn(async () => ({ usage: [] }));
        const { result } = renderHook(() => useUsage('kb', 'kb1', { fetcher }));
        expect(result.current.usage).toBeNull();
        expect(result.current.loading).toBe(true);
        await waitFor(() => expect(result.current.usage).toEqual([]));
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('hands the rows through untouched — the shape is the renderer’s business', async () => {
        const rows = [{ kind: 'agent', id: 'a1', title: 'Quote assistant', role: 'read' }];
        const fetcher = vi.fn(async () => ({ usage: rows }));
        const { result } = renderHook(() => useUsage('kb', 'kb1', { fetcher }));
        await waitFor(() => expect(result.current.usage).toEqual(rows));
    });

    it('a failed read becomes [] plus an error, never a null that lasts forever', async () => {
        // "Still loading" and "nothing depends on this" look identical from
        // the delete confirmation. The error is what tells them apart.
        const fetcher = vi.fn(async () => { throw new Error('boom'); });
        const { result } = renderHook(() => useUsage('agent', 'a1', { fetcher }));
        await waitFor(() => expect(result.current.usage).toEqual([]));
        expect(result.current.error).toBe('boom');
        expect(result.current.loading).toBe(false);
    });

    it('an unsaved thing (no id) is loaded-empty without a request', async () => {
        const fetcher = vi.fn();
        const { result } = renderHook(() => useUsage('agent', null, { fetcher }));
        await waitFor(() => expect(result.current.usage).toEqual([]));
        expect(fetcher).not.toHaveBeenCalled();
    });
});

describe('useUsage — one fetch', () => {
    it('fetches ONCE per (kind, id), however often the consumer re-renders', async () => {
        const fetcher = vi.fn(async () => ({ usage: [] }));
        const { result, rerender } = renderHook(
            // A fresh inline fetcher on every render, as a real caller writes it.
            ({ n }) => useUsage('datatable', 'tbl_1', { fetcher: (...a) => fetcher(...a, n) }),
            { initialProps: { n: 0 } },
        );
        await waitFor(() => expect(result.current.usage).toEqual([]));
        rerender({ n: 1 });
        rerender({ n: 2 });
        await waitFor(() => expect(result.current.usage).toEqual([]));
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledWith('datatable', 'tbl_1', 0);
    });

    it('refetch() asks again, and the list goes back to null while it does', async () => {
        let calls = 0;
        const fetcher = vi.fn(async () => ({ usage: calls++ === 0 ? [] : [{ kind: 'app', id: 'p1', title: 'Portal', role: 'read' }] }));
        const { result } = renderHook(() => useUsage('datatable', 'tbl_1', { fetcher }));
        await waitFor(() => expect(result.current.usage).toEqual([]));
        act(() => result.current.refetch());
        await waitFor(() => expect(result.current.usage).toHaveLength(1));
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('a new id refetches and ignores the late answer for the old one', async () => {
        const gate = {};
        const fetcher = vi.fn((kind, id) => new Promise((resolve) => { gate[id] = resolve; }));
        const { result, rerender } = renderHook(({ id }) => useUsage('kb', id, { fetcher }), { initialProps: { id: 'kb1' } });
        rerender({ id: 'kb2' });
        await act(async () => { gate.kb2({ usage: [{ kind: 'agent', id: 'a2', title: 'Two', role: 'read' }] }); });
        await waitFor(() => expect(result.current.usage?.[0]?.id).toBe('a2'));
        // The old request answering late must not overwrite the new list.
        await act(async () => { gate.kb1({ usage: [{ kind: 'agent', id: 'a1', title: 'One', role: 'read' }] }); });
        expect(result.current.usage[0].id).toBe('a2');
    });

    it('setUsage replaces the shared list (the 409 payload is fresher than the cache)', async () => {
        const fetcher = vi.fn(async () => ({ usage: [] }));
        const { result } = renderHook(() => useUsage('kb', 'kb1', { fetcher }));
        await waitFor(() => expect(result.current.usage).toEqual([]));
        act(() => result.current.setUsage([{ kind: 'agent', id: 'a1', title: 'A', role: 'read' }]));
        expect(result.current.usage).toHaveLength(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

describe('the default fetcher', () => {
    it('maps every kind to its API path', () => {
        expect(USAGE_KIND_PATH).toEqual({
            kb: 'kb', agent: 'agents', skill: 'skills',
            datatable: 'datatables', webpage: 'webpages', meeting: 'transcriptions',
        });
        expect(usageUrl('agent', 'a1')).toBe('/api/agents/a1/usage');
        expect(usageUrl('meeting', 'm 1')).toBe('/api/transcriptions/m%201/usage');
        expect(usageUrl('chat', 'c1')).toBeNull();
    });

    it('GETs /api/<kindPath>/:id/usage through authFetch and unwraps {usage}', async () => {
        authFetch.mockResolvedValue(ok({ usage: [{ kind: 'agent', id: 'a1', title: 'A', role: 'read' }] }));
        const { result } = renderHook(() => useUsage('kb', 'kb1'));
        await waitFor(() => expect(result.current.usage).toHaveLength(1));
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(authFetch.mock.calls[0][0]).toBe('/api/kb/kb1/usage');
    });

    it('a non-2xx answer is an error carrying status, code and body', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden', code: 'no_access' }) });
        await expect(defaultUsageFetcher('agent', 'a1')).rejects.toMatchObject({ status: 403, code: 'no_access', message: 'Forbidden' });
    });

    it('refuses a kind without an endpoint instead of guessing a URL', async () => {
        const { result } = renderHook(() => useUsage('chat', 'c1'));
        await waitFor(() => expect(result.current.usage).toEqual([]));
        expect(result.current.error).toMatch(/No usage endpoint/);
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('normaliseUsage accepts a bare array, {usage}, and anything else as empty', () => {
        expect(normaliseUsage([1])).toEqual([1]);
        expect(normaliseUsage({ usage: [2] })).toEqual([2]);
        expect(normaliseUsage({ usage: 'nope' })).toEqual([]);
        expect(normaliseUsage(null)).toEqual([]);
    });
});
