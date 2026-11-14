import { notifyManager } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';

import useShieldActivity from './useShieldActivity';

// Under fake timers the query would hand its answer to React on a 0 ms timer; a
// microtask keeps the answer inside the tick that produced it.
notifyManager.setScheduler(queueMicrotask);

// The requests are seen at the browser's fetch, under the session and CSRF headers authFetch adds.
const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

/** Every endpoint answers; `total` is the guardrail total the overview reports. */
function answer(total: number) {
    fetchMock.mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/guardrails/overview')) return json({ summary: { total_events: total } });
        if (u.includes('/integrations/overview')) return json({ summary: { total_calls: 3 }, top: { destinations: [{ dest_host: 'a.example' }] } });
        if (u.includes('/guardrails/recent')) return json([{ id: 'g1' }]);
        return json([{ id: 'e1' }, { id: 'e2' }]);
    });
}

const urls = () => fetchMock.mock.calls.map(c => String(c[0]).replace(/^.*(?=\/api\/usage\/)/, ''));
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const mount = (props: Partial<Parameters<typeof useShieldActivity>[0]> = {}) => renderHook(
    (p: Partial<Parameters<typeof useShieldActivity>[0]>) => useShieldActivity({ enabled: true, rangeParams: { days: 30 }, ...props, ...p }),
    { wrapper: queryWrapper(), initialProps: {} },
);

beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => fetchMock(url, init)); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('useShieldActivity', () => {
    it('asks the two aggregates and the two ledgers of the window and shows them over the empty shape', async () => {
        answer(12);
        const { result } = mount({ orgId: 'org-b' });
        expect(result.current.loading).toBe(true);
        await settle();
        expect(urls()).toEqual([
            '/api/usage/guardrails/overview?days=30&orgId=org-b',
            '/api/usage/integrations/overview?days=30&orgId=org-b',
            '/api/usage/guardrails/recent?days=30&limit=200&orgId=org-b',
            '/api/usage/integrations/egress?days=30&limit=200&orgId=org-b',
        ]);
        expect(result.current).toMatchObject({ loading: false, loaded: true, refreshing: false, error: null, limit: 200 });
        expect(result.current.guard).toMatchObject({ summary: { total_events: 12 }, timeline: [] });
        expect(result.current.integ.top).toMatchObject({ destinations: [{ dest_host: 'a.example' }], users: [] });
        expect(result.current.guardRows).toEqual([{ id: 'g1' }]);
        expect(result.current.egressRows).toHaveLength(2);
    });

    it('asks nothing while off, and only the aggregates without detail', async () => {
        answer(1);
        const { rerender } = mount({ enabled: false });
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
        rerender({ enabled: true, detail: false });
        await settle();
        expect(urls()).toEqual(['/api/usage/guardrails/overview?days=30', '/api/usage/integrations/overview?days=30']);
    });

    it('reads a 404 as empty and any other refusal as an error', async () => {
        fetchMock.mockResolvedValue(json({}, 404));
        const first = mount();
        await settle();
        expect(first.result.current).toMatchObject({ loaded: true, error: null, guardRows: [], guard: { summary: {} } });
        first.unmount();

        fetchMock.mockResolvedValue(json({ error: 'nope' }, 500));
        const second = mount();
        await settle();
        expect(second.result.current).toMatchObject({ loaded: false, loading: false, error: 'HTTP 500' });
    });

    it('refreshes every 30 seconds, keeps the data on screen meanwhile, and a failed refresh keeps it too', async () => {
        answer(12);
        const { result } = mount();
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(4);
        await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
        expect(fetchMock).toHaveBeenCalledTimes(4);

        answer(13);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(fetchMock).toHaveBeenCalledTimes(8);
        expect(result.current.loading).toBe(false);
        expect(result.current.guard.summary).toEqual({ total_events: 13 });

        fetchMock.mockRejectedValue(new Error('offline'));
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(fetchMock.mock.calls.length).toBeGreaterThan(8);
        expect(result.current.error).toBeNull();
        expect(result.current.guard.summary).toEqual({ total_events: 13 });
    });

    it('does not refresh when polling is off', async () => {
        answer(12);
        mount({ poll: false });
        await settle();
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('a window that fails keeps the previous window on screen and reports the failure', async () => {
        answer(12);
        const { result, rerender } = mount();
        await settle();
        fetchMock.mockResolvedValue(json({}, 500));
        rerender({ rangeParams: { days: 7 } });
        await settle();
        expect(result.current.error).toBe('HTTP 500');
        expect(result.current.loading).toBe(false);
        expect(result.current.guard.summary).toEqual({ total_events: 12 });
    });
});
