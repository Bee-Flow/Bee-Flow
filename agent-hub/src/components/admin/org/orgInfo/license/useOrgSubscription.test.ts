import { notifyManager } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import useOrgSubscription from './useOrgSubscription';

// Under fake timers the query would hand its answer to React on a 0 ms timer; a
// microtask keeps the answer inside the tick that produced it.
notifyManager.setScheduler(queueMicrotask);

// The requests are seen at the browser's fetch, under the session and CSRF headers authFetch adds.
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const path = (url: unknown) => String(url).replace(/^.*(?=\/api\/)/, '');
const t = (_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _key);
const reply = (ok: boolean, body: unknown) => ({ ok, json: async () => body }) as unknown as Response;
const PLANS = [{ id: 'p1', price: 10 }];

/** The subscription route answers with `subscription()`; Stripe says it is on and offers PLANS. */
function answer(subscription: () => Response) {
    fetchMock.mockImplementation(async (url) => {
        if (url.endsWith('/api/stripe/status')) return reply(true, { enabled: true });
        if (url.endsWith('/api/stripe/plans')) return reply(true, PLANS);
        if (url.includes('/api/stripe/sessions/')) return reply(true, {});
        return subscription();
    });
}

const urls = () => fetchMock.mock.calls.map(c => c[0]);
const mount = (orgId: string | undefined) => renderHook(() => useOrgSubscription(orgId, 'cloud', t), { wrapper: queryWrapper() });

beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => fetchMock(path(url), init));
    window.history.replaceState({}, '', '/settings');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('useOrgSubscription', () => {
    it('reads the subscription, the Stripe status and the plans', async () => {
        answer(() => reply(true, { status: 'active', plan_name: 'Pro' }));
        const { result } = mount('org1');
        expect(result.current.subLoading).toBe(true);
        await waitFor(() => expect(result.current.subscription).toEqual({ status: 'active', plan_name: 'Pro' }));
        await waitFor(() => expect(result.current.availablePlans).toEqual(PLANS));
        expect(result.current.stripeEnabled).toBe(true);
        expect(result.current.subLoading).toBe(false);
        expect(urls().sort()).toEqual(['/api/stripe/plans', '/api/stripe/status', '/api/subscriptions/orgs/org1']);
    });

    it('has no subscription when the server refuses or cannot be reached, and asks for none without an organisation', async () => {
        answer(() => reply(false, { error: 'forbidden' }));
        const refused = mount('org1');
        await waitFor(() => expect(refused.result.current.subLoading).toBe(false));
        expect(refused.result.current.subscription).toBeNull();
        refused.unmount();

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        answer(() => { throw new Error('offline'); });
        const offline = mount('org1');
        await waitFor(() => expect(warn).toHaveBeenCalled());
        expect(offline.result.current.subscription).toBeNull();
        offline.unmount();
        warn.mockRestore();

        fetchMock.mockClear();
        const none = mount(undefined);
        await waitFor(() => expect(urls()).toContain('/api/stripe/status'));
        expect(urls().filter(u => u.includes('/api/subscriptions/'))).toEqual([]);
        expect(none.result.current.subLoading).toBe(false);
    });

    it('an action writes its answer as the subscription', async () => {
        answer(() => reply(true, { status: 'active' }));
        const { result } = mount('org1');
        await waitFor(() => expect(result.current.subscription).toEqual({ status: 'active' }));
        fetchMock.mockResolvedValueOnce(reply(true, { status: 'active', cancel_at_period_end: true }));
        await act(() => result.current.doCancelSubscription());
        expect(result.current.subscription).toEqual({ status: 'active', cancel_at_period_end: true });
    });

    it('a cancelled checkout says so and clears the address', async () => {
        window.history.replaceState({}, '', '/settings?checkout=cancelled');
        answer(() => reply(false, {}));
        const { result } = mount('org1');
        await waitFor(() => expect(result.current.subMessage).toEqual({ type: 'error', text: 'Checkout was cancelled. No changes were made.' }));
        expect(window.location.search).toBe('');
        expect(result.current.checkoutSettling).toBe(false);
    });

    it('a successful checkout looks every 1.5 s, reconciles from the session and takes the active subscription', async () => {
        vi.useFakeTimers();
        window.history.replaceState({}, '', '/settings?checkout=success&session_id=cs_1');
        let looks = 0;
        answer(() => { looks += 1; return reply(true, looks >= 3 ? { status: 'active' } : { status: 'incomplete' }); });
        const { result } = mount('org1');
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(result.current.checkoutSettling).toBe(true);
        expect(looks).toBe(1);   // the mount's own read
        await act(async () => { await vi.advanceTimersByTimeAsync(1499); });
        expect(looks).toBe(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(looks).toBe(2);
        expect(urls()).toContain('/api/stripe/sessions/cs_1');
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
        expect(result.current.checkoutSettling).toBe(false);
        expect(result.current.subscription).toEqual({ status: 'active' });
        expect(result.current.subMessage).toEqual({ type: 'success', text: 'Subscription activated!' });
        expect(window.location.search).toBe('');
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(looks).toBe(3);
    });

    it('gives up after 30 s with the delayed-activation message, and stops looking when the page is left', async () => {
        vi.useFakeTimers();
        window.history.replaceState({}, '', '/settings?checkout=success');
        answer(() => reply(true, { status: 'incomplete' }));
        const slow = mount('org1');
        await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
        expect(slow.result.current.checkoutSettling).toBe(false);
        expect(slow.result.current.subMessage?.type).toBe('error');
        expect(slow.result.current.subMessage?.text).toMatch(/activation is taking longer/);
        slow.unmount();

        window.history.replaceState({}, '', '/settings?checkout=success');
        const left = mount('org1');
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
        left.unmount();
        // A look that was already waiting still happens; none after it.
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
        fetchMock.mockClear();
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
