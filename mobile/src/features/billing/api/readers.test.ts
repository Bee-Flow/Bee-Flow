import { readCheckoutSession, readInvoices, readPlanChangePreview, readPlans, readSubscription } from './readers';

/** GET /api/subscriptions/orgs/:orgId as subscriptions/orgSubscriptions.js sends it (trimmed). */
const SUBSCRIPTION = {
    organization_id: 'o1',
    plan_id: 'team',
    plan_name: 'Team',
    status: 'active',
    payment_status: 'paid',
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    billing_cycle_start: '2026-09-01T00:00:00.000Z',
    cancel_at_period_end: false,
    cancel_at: null,
    current_period_end: '2026-10-01T00:00:00.000Z',
    pending_plan_id: null,
    pending_plan_effective: null,
    pending_plan_name: null,
    notes: 'Invoiced yearly',
    effective_limits: { max_cost_per_month: 30, max_users: 10, max_agents: -1, max_knowledge_sources: null, seat_count: 3 },
    billing: {
        plan_price: 10,
        plan_currency: 'EUR',
        billing_interval: 'monthly',
        per_seat: true,
        seat_quantity: 3,
        subscription_total: 30,
        usage_pooled: false,
        per_user_cap: 10,
    },
    current_usage: { cost: 12.3 },
    upgradeable_plans: [],
    changeable_plans: [
        { id: 'pro', name: 'Pro', description: null, price: 20, currency: 'eur', billing_interval: 'monthly', per_seat: true, has_stripe_price: true, direction: 'upgrade' },
        { name: 'no id' },
    ],
};

describe('billing readers', () => {
    it('reads the subscription into camelCase with its limits, billing and pickers', () => {
        const sub = readSubscription(SUBSCRIPTION);
        expect(sub).toMatchObject({
            planName: 'Team',
            paymentStatus: 'paid',
            stripeSubscriptionId: 'sub_1',
            notes: 'Invoiced yearly',
            usageCost: 12.3,
            limits: { maxCostPerMonth: 30, maxUsers: 10, maxAgents: -1, maxKnowledgeSources: null },
            billing: { perSeat: true, seatQuantity: 3, subscriptionTotal: 30, usagePooled: false, perUserCap: 10 },
        });
        expect(sub?.changeablePlans).toEqual([
            expect.objectContaining({ id: 'pro', price: 20, perSeat: true, hasStripePrice: true, direction: 'upgrade' }),
        ]);
    });

    it('reads no body as no subscription, and a plan-less one without billing', () => {
        expect(readSubscription(null)).toBeNull();
        expect(readSubscription({ status: 'active' })).toMatchObject({ billing: null, changeablePlans: [], usageCost: 0 });
    });

    it('reads the plans on sale with the server’s defaults', () => {
        expect(readPlans([{ id: 'basic', name: 'Basic', price: 9 }, 'junk'])).toEqual([
            expect.objectContaining({ id: 'basic', currency: 'eur', billingInterval: 'monthly', trialDays: 0, direction: null }),
        ]);
        expect(readPlans({ error: 'x' })).toEqual([]);
    });

    it('reads a preview, a session and the invoices', () => {
        expect(
            readPlanChangePreview({ direction: 'downgrade', currency: 'EUR', plan_name: 'Basic', per_seat: false, seat_quantity: 1, next_renewal_total: 9, proration_amount: 0, effective: '2026-10-01' }),
        ).toEqual({ direction: 'downgrade', currency: 'EUR', planName: 'Basic', perSeat: false, seatQuantity: 1, nextRenewalTotal: 9, prorationAmount: 0, effective: '2026-10-01' });
        expect(readCheckoutSession({ id: 'cs_1', status: 'complete', subscription_status: 'trialing' })).toEqual({ status: 'complete', subscriptionStatus: 'trialing' });
        expect(
            readInvoices({ invoices: [{ id: 'in_1', number: 'A-1', amountPaid: 30, amountDue: 30, currency: 'EUR', status: 'paid', invoicePdf: 'https://x' }, { number: 'no id' }] }),
        ).toEqual([
            { id: 'in_1', number: 'A-1', created: null, amountPaid: 30, amountDue: 30, currency: 'EUR', status: 'paid', invoicePdf: 'https://x' },
        ]);
    });
});
