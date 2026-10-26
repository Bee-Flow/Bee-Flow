import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import useSubscriptionActions from './useSubscriptionActions';
import { cloudFetch } from '@/api/cloudFetch';

vi.mock('@/api/cloudFetch', () => ({ cloudFetch: vi.fn() }));
vi.mock('@/utils/helpers', () => ({ API_BASE: '' }));

const fetchMock = vi.mocked(cloudFetch);
const t = (_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _key);
const reply = (ok: boolean, body: unknown) => ({ ok, json: async () => body }) as unknown as Response;

function setup() {
    const setSubscription = vi.fn();
    const setSubMessage = vi.fn();
    const { result } = renderHook(() => useSubscriptionActions({ orgId: 'org1', deploymentMode: 'cloud', t, setSubscription, setSubMessage }));
    return { result, setSubscription, setSubMessage };
}

beforeEach(() => fetchMock.mockReset());

describe('useSubscriptionActions', () => {
    it('cancels at period end and closes the confirmation', async () => {
        fetchMock.mockResolvedValueOnce(reply(true, { status: 'active', cancel_at_period_end: true }));
        const { result, setSubscription, setSubMessage } = setup();
        act(() => result.current.handleCancelSubscription());
        expect(result.current.showCancelConfirm).toBe(true);
        await act(() => result.current.doCancelSubscription());
        expect(fetchMock).toHaveBeenCalledWith('cloud', '/api/subscriptions/orgs/org1/cancel', { method: 'POST' });
        expect(setSubscription).toHaveBeenCalledWith({ status: 'active', cancel_at_period_end: true });
        expect(setSubMessage).toHaveBeenCalledWith({ type: 'success', text: 'Cancellation scheduled.' });
        expect(result.current.showCancelConfirm).toBe(false);
        expect(result.current.cancelBusy).toBe(false);
    });

    it('reports the server wording when a reactivation is refused', async () => {
        fetchMock.mockResolvedValueOnce(reply(false, { message: 'Nope' }));
        const { result, setSubscription, setSubMessage } = setup();
        await act(() => result.current.handleReactivateSubscription());
        expect(setSubscription).not.toHaveBeenCalled();
        expect(setSubMessage).toHaveBeenCalledWith({ type: 'error', text: 'Nope' });
    });

    it('maps a declined card on a plan change to its own message', async () => {
        fetchMock
            .mockResolvedValueOnce(reply(true, { direction: 'upgrade', proration_amount: 5 }))
            .mockResolvedValueOnce(reply(false, { error: 'payment_required' }));
        const { result, setSubMessage } = setup();
        await act(() => result.current.handleSelectChange({ id: 'p2', price: 10 }));
        expect(result.current.changePreview).toEqual({ direction: 'upgrade', proration_amount: 5 });
        await act(() => result.current.handleConfirmChange());
        expect(setSubMessage).toHaveBeenLastCalledWith({
            type: 'error',
            text: 'Your card was declined. Update your payment method via "Manage Billing".',
        });
    });

    it('falls back to its own message when checkout returns no URL', async () => {
        fetchMock.mockResolvedValueOnce(reply(false, {}));
        const { result, setSubMessage } = setup();
        await act(() => result.current.handleCheckout('p1'));
        expect(setSubMessage).toHaveBeenCalledWith({ type: 'error', text: 'Failed to start checkout' });
        expect(result.current.checkoutLoading).toBeNull();
    });
});
