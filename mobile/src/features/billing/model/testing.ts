/** Test-only: a subscription with the server's defaults, overridden per case. */

import type { Plan, Subscription } from './types';

export function plan(over: Partial<Plan> = {}): Plan {
    return {
        id: 'pro',
        name: 'Pro',
        description: null,
        price: 49,
        currency: 'eur',
        billingInterval: 'monthly',
        trialDays: 0,
        maxUsers: null,
        maxAgents: null,
        maxKnowledgeSources: null,
        perSeat: false,
        hasStripePrice: true,
        direction: null,
        ...over,
    };
}

export function subscription(over: Partial<Subscription> = {}): Subscription {
    return {
        planId: 'team',
        planName: 'Team',
        status: 'active',
        paymentStatus: 'paid',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        billingCycleStart: '2026-09-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        cancelAt: null,
        currentPeriodEnd: null,
        pendingPlanId: null,
        pendingPlanEffective: null,
        pendingPlanName: null,
        notes: null,
        limits: { maxCostPerMonth: 100, maxUsers: 10, maxAgents: -1, maxKnowledgeSources: null },
        billing: {
            planPrice: 10,
            planCurrency: 'EUR',
            billingInterval: 'monthly',
            perSeat: true,
            seatQuantity: 3,
            subscriptionTotal: 30,
            usagePooled: true,
            perUserCap: null,
        },
        usageCost: 42.4,
        changeablePlans: [plan({ direction: 'upgrade' })],
        ...over,
    };
}
