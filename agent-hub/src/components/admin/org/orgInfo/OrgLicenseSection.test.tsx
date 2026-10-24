import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingPlan, OrgSubscription } from './license/licenseShared';
import type { OrgSubscriptionState } from './license/useOrgSubscription';
import OrgLicenseSection from './OrgLicenseSection';

vi.mock('../../../../hooks/useTranslation', () => import('@/test/useTranslationMock'));
vi.mock('../../../billing/InvoicesPanel', () => ({ default: () => <div data-testid="invoices" /> }));

const PLAN: BillingPlan = { id: 'p1', name: 'Team', price: 20, currency: 'eur', billing_interval: 'monthly', has_stripe_price: true };

function billingState(overrides: Partial<OrgSubscriptionState> = {}): OrgSubscriptionState {
    return {
        subscription: null, subLoading: false, availablePlans: [], stripeEnabled: true,
        subMessage: null, setSubMessage: vi.fn(), checkoutSettling: false,
        checkoutLoading: null, handleCheckout: vi.fn(async () => {}),
        portalLoading: false, handleManageBilling: vi.fn(async () => {}),
        showChangePlan: false, setShowChangePlan: vi.fn(), handleSelectChange: vi.fn(async () => {}),
        previewLoading: false, changeTarget: null, setChangeTarget: vi.fn(),
        changePreview: null, setChangePreview: vi.fn(), changeBusy: false, handleConfirmChange: vi.fn(async () => {}),
        cancelBusy: false, handleCancelDowngrade: vi.fn(async () => {}), handleReactivateSubscription: vi.fn(async () => {}),
        handleCancelSubscription: vi.fn(), doCancelSubscription: vi.fn(async () => {}),
        showCancelConfirm: false, setShowCancelConfirm: vi.fn(),
        ...overrides,
    };
}

function renderSection(billing: OrgSubscriptionState, extra: { hasActiveLicenseKey?: boolean; serverOverride?: boolean } = {}) {
    return render(
        <OrgLicenseSection
            licenseCtx={{ serverOverride: extra.serverOverride }}
            hasActiveLicenseKey={!!extra.hasActiveLicenseKey}
            isCloud
            deploymentMode="cloud"
            orgData={{ usagePooled: true }}
            setOrgData={vi.fn()}
            billing={billing}
            goToUsersPanel={vi.fn()}
        />,
    );
}

afterEach(cleanup);

describe('OrgLicenseSection', () => {
    it('offers the checkout plans to an org without a subscription', async () => {
        const billing = billingState({ availablePlans: [PLAN] });
        renderSection(billing);
        expect(screen.getByText('Choose a Plan')).toBeTruthy();
        expect(screen.getByText('€20.00')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: /Subscribe/ }));
        expect(billing.handleCheckout).toHaveBeenCalledWith('p1');
    });

    it('shows neither placeholder nor plans for an org on a licence key', () => {
        renderSection(billingState({ availablePlans: [PLAN] }), { hasActiveLicenseKey: true });
        expect(screen.queryByText('Choose a Plan')).toBeNull();
    });

    it('hides the subscription dashboard under a server-wide licence', () => {
        renderSection(billingState({ availablePlans: [PLAN] }), { serverOverride: true });
        expect(screen.getByText('Tier is managed server-wide')).toBeTruthy();
        expect(screen.queryByText('Choose a Plan')).toBeNull();
    });

    it('renders an active per-seat subscription with its plan picker and sharing toggle', async () => {
        const sub: OrgSubscription = {
            plan_name: 'Team', status: 'active', stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1',
            payment_status: 'paid',
            changeable_plans: [{ ...PLAN, id: 'p2', name: 'Business', direction: 'upgrade' }],
            effective_limits: { max_cost_per_month: 100, max_users: 10 },
            current_usage: { cost: 90 },
            billing: { subscription_total: 40, per_seat: true, plan_currency: 'EUR', plan_price: 20, seat_quantity: 2, billing_interval: 'monthly' },
        };
        const billing = billingState({ subscription: sub, showChangePlan: true });
        renderSection(billing);
        expect(screen.getByText('Subscription & Usage')).toBeTruthy();
        expect(screen.getByTestId('invoices')).toBeTruthy();
        expect(screen.getByText('Business')).toBeTruthy();
        expect(screen.getByText('2 / 10')).toBeTruthy();
        expect(screen.getByText('Pooled across the organisation')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: /Upgrade plan/ }));
        expect(billing.setShowChangePlan).toHaveBeenCalledWith(true);
        await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
        expect(billing.handleCancelSubscription).toHaveBeenCalled();
    });

    it('confirms a downgrade with its cost preview', async () => {
        const billing = billingState({
            subscription: { status: 'active' },
            changeTarget: { ...PLAN, direction: 'downgrade' },
            changePreview: { direction: 'downgrade', currency: 'EUR', next_renewal_total: 10 },
        });
        renderSection(billing);
        expect(screen.getByText(/Confirm downgrade/)).toBeTruthy();
        expect(screen.getByText('€10.00 / month')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(billing.handleConfirmChange).toHaveBeenCalled();
    });
});
