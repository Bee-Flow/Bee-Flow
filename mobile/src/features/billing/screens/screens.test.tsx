/**
 * License & Usage, Plans and Invoices against canned server answers: what
 * each shows, the exact request each action sends, the Stripe hand-offs and
 * their return, and who is turned away.
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { AppState } from 'react-native';

import { api, ApiError } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { BillingScreen } from './BillingScreen';
import { InvoicesScreen } from './InvoicesScreen';
import { PlansScreen } from './PlansScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockAccess = { isOrgAdmin: true, mode: 'cloud', serverOverride: false };

jest.mock('expo-router', () => ({ useRouter: () => mockRouter, Stack: { Screen: () => null } }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn(async () => 'file:///invoice.pdf') }));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'me', organizationId: 'o1' } }) }));
jest.mock('@/core/access', () => ({
    ...jest.requireActual('@/core/access'),
    useAccess: () => ({
        isOrgAdmin: mockAccess.isOrgAdmin,
        mode: mockAccess.mode,
        license: { serverOverride: mockAccess.serverOverride },
    }),
}));
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const PLAN = { id: 'pro', name: 'Pro', price: 20, currency: 'eur', billing_interval: 'monthly', has_stripe_price: true };
const SUB = {
    plan_id: 'team',
    plan_name: 'Team',
    status: 'active',
    payment_status: 'paid',
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    billing_cycle_start: '2026-09-01T00:00:00.000Z',
    effective_limits: { max_cost_per_month: 100, max_users: 10 },
    billing: { plan_price: 10, plan_currency: 'EUR', billing_interval: 'monthly', per_seat: true, seat_quantity: 3, subscription_total: 30, usage_pooled: true },
    current_usage: { cost: 42 },
    changeable_plans: [{ ...PLAN, direction: 'upgrade' }],
};

let answers: Record<string, unknown> = {};

beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockAccess, { isOrgAdmin: true, mode: 'cloud', serverOverride: false });
    answers = {
        '/api/subscriptions/orgs/o1': SUB,
        '/api/stripe/plans': [PLAN],
        '/auth/organizations/o1': { id: 'o1', name: 'Acme', usagePooled: true },
    };
    (api.get as jest.Mock).mockImplementation((path: string) => {
        if (!(path in answers)) return Promise.reject(new ApiError('Not found', { status: 404, body: { error: 'x' } }));
        return Promise.resolve(answers[path]);
    });
    (api.post as jest.Mock).mockResolvedValue({ ok: true });
    (api.put as jest.Mock).mockResolvedValue({ success: true });
});

describe('BillingScreen', () => {
    it('shows the plan, usage against the cap, the seats and the limits', async () => {
        await renderScreen(<BillingScreen />);
        expect(await screen.findByText('Team')).toBeTruthy();
        expect(screen.getByText('Subscription & Usage')).toBeTruthy();
        expect(screen.getAllByText('42%')).toHaveLength(1);
        expect(screen.getByText('Active')).toBeTruthy();
        expect(screen.queryByText('AI usage of cap this period')).toBeNull();
        expect(screen.getByText('€30.00 / month')).toBeTruthy();
        expect(screen.getByText('3 / 10')).toBeTruthy();
        expect(screen.getByTestId('billing-change-plan')).toBeTruthy();
    });

    it('asks before cancelling, then posts the cancel with no body and re-reads', async () => {
        await renderScreen(<BillingScreen />);
        await fireEvent.press(await screen.findByTestId('billing-cancel'));
        expect(api.post).not.toHaveBeenCalled();
        const [, confirm] = screen.getAllByLabelText('Cancel subscription');
        await fireEvent.press(confirm as NonNullable<typeof confirm>);
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/subscriptions/orgs/o1/cancel'));
        await waitFor(() => expect((api.get as jest.Mock).mock.calls.filter(([p]) => p === '/api/subscriptions/orgs/o1').length).toBe(2));
    });

    it('undoes a scheduled downgrade', async () => {
        answers['/api/subscriptions/orgs/o1'] = { ...SUB, pending_plan_id: 'basic', pending_plan_name: 'Basic', changeable_plans: [] };
        await renderScreen(<BillingScreen />);
        expect(await screen.findByText(/Downgrade to Basic on/)).toBeTruthy();
        expect(screen.queryByTestId('billing-change-plan')).toBeNull();
        await fireEvent.press(screen.getByTestId('billing-keep-plan'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/subscriptions/orgs/o1/cancel-downgrade'));
    });

    it('opens the Customer Portal in the in-app browser', async () => {
        (api.post as jest.Mock).mockResolvedValue({ url: 'https://billing.stripe.com/p/1' });
        await renderScreen(<BillingScreen />);
        await fireEvent.press(await screen.findByTestId('billing-portal'));
        await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://billing.stripe.com/p/1', { createTask: false }));
        expect(api.post).toHaveBeenCalledWith('/api/stripe/portal', {});
    });

    it('saves the usage split on the organisation', async () => {
        await renderScreen(<BillingScreen />);
        await fireEvent(await screen.findByTestId('billing-usage-pooled'), 'valueChange', false);
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/organizations/o1', { usagePooled: false }));
    });

    it('offers the plans on sale when there is no subscription', async () => {
        delete answers['/api/subscriptions/orgs/o1'];
        await renderScreen(<BillingScreen />);
        expect(await screen.findByText('No license assigned')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('billing-choose-plan'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/billing/plans');
    });

    it('says a self-hosted install uses licence keys, and asks the server nothing', async () => {
        mockAccess.mode = 'self-hosted';
        await renderScreen(<BillingScreen />);
        expect(screen.getByText('Subscriptions are a Bee Flow Cloud feature')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalledWith('/api/subscriptions/orgs/o1', expect.anything());
    });

    it('replaces the subscription with a note under a server-wide licence', async () => {
        mockAccess.serverOverride = true;
        await renderScreen(<BillingScreen />);
        expect(await screen.findByText(/Tier is managed server-wide/)).toBeTruthy();
        expect(api.get).not.toHaveBeenCalledWith('/api/subscriptions/orgs/o1', expect.anything());
    });
});

describe('PlansScreen', () => {
    it('previews a plan change, then confirms it in place', async () => {
        (api.post as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(
                path.endsWith('/preview-change')
                    ? { direction: 'upgrade', currency: 'EUR', per_seat: false, seat_quantity: 1, next_renewal_total: 20, proration_amount: 6.5, effective: 'now' }
                    : { ok: true },
            ),
        );
        await renderScreen(<PlansScreen />);
        await fireEvent.press(await screen.findByTestId('plan-pro-pick'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/subscriptions/orgs/o1/preview-change', { planId: 'pro' }));
        expect(await screen.findByText('€6.50')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('billing-confirm-change'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/subscriptions/orgs/o1/upgrade', { planId: 'pro' }));
        expect(mockRouter.back).toHaveBeenCalled();
    });

    it('sends a free plan to Checkout, and settles it when the app is back in front', async () => {
        answers['/api/subscriptions/orgs/o1'] = { ...SUB, stripe_subscription_id: null, billing: null, changeable_plans: [] };
        answers['/api/stripe/sessions/cs_1'] = { id: 'cs_1', status: 'complete', subscription_status: 'active' };
        (api.post as jest.Mock).mockResolvedValue({ url: 'https://checkout.stripe.com/c/1', sessionId: 'cs_1' });
        const listeners: ((state: string) => void)[] = [];
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
            listeners.push(listener as (state: string) => void);
            return { remove: jest.fn() } as never;
        });
        await renderScreen(<PlansScreen />);
        expect(await screen.findByText(/This is a recurring subscription/)).toBeTruthy();
        await fireEvent.press(screen.getByTestId('plan-pro-pick'));
        await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://checkout.stripe.com/c/1', { createTask: false }));
        expect(api.post).toHaveBeenCalledWith('/api/stripe/checkout', { planId: 'pro' });

        answers['/api/subscriptions/orgs/o1'] = SUB;
        await act(async () => listeners.forEach((listener) => listener('active')));
        expect(await screen.findByText('Subscription activated!')).toBeTruthy();
        expect(api.get).toHaveBeenCalledWith('/api/stripe/sessions/cs_1');
    });

    it('reads a checkout the customer left as cancelled', async () => {
        answers['/api/subscriptions/orgs/o1'] = { ...SUB, stripe_subscription_id: null, billing: null, changeable_plans: [] };
        answers['/api/stripe/sessions/cs_1'] = { id: 'cs_1', status: 'open' };
        (api.post as jest.Mock).mockResolvedValue({ url: 'https://checkout.stripe.com/c/1', sessionId: 'cs_1' });
        const listeners: ((state: string) => void)[] = [];
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
            listeners.push(listener as (state: string) => void);
            return { remove: jest.fn() } as never;
        });
        await renderScreen(<PlansScreen />);
        await fireEvent.press(await screen.findByTestId('plan-pro-pick'));
        await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalled());
        await act(async () => listeners.forEach((listener) => listener('active')));
        expect(await screen.findByText('Checkout was cancelled. No changes were made.')).toBeTruthy();
    });
});

describe('InvoicesScreen', () => {
    it('lists the invoices and shares a PDF fetched on the app’s session', async () => {
        answers['/api/stripe/invoices'] = {
            invoices: [{ id: 'in_1', number: 'BF-0001', created: '2026-09-01T00:00:00.000Z', amountPaid: 30, currency: 'EUR', status: 'paid', invoicePdf: 'https://pay.stripe.com/x' }],
        };
        await renderScreen(<InvoicesScreen />);
        expect(await screen.findByText('BF-0001')).toBeTruthy();
        expect(screen.getByText('Paid')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('invoice-in_1-pdf'));
        await waitFor(() =>
            expect(shareServerFile).toHaveBeenCalledWith('/api/stripe/invoices/in_1/pdf', 'BF-0001.pdf', 'application/pdf'),
        );
    });

    it('turns a member away without asking', async () => {
        mockAccess.isOrgAdmin = false;
        await renderScreen(<InvoicesScreen />);
        expect(screen.getByText('For organisation administrators')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalled();
    });
});
