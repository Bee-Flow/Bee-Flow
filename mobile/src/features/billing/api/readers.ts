/**
 * Contract readers for the subscription and Stripe payloads (model/types.ts
 * names each route). The server speaks snake_case here; the readers rename to
 * the app's camelCase and keep the server's own defaults: a plan without a
 * currency is euro, a subscription without `billing` has no plan to bill.
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    CheckoutSession,
    CheckoutStart,
    Invoice,
    Plan,
    PlanChangePreview,
    PlanLimits,
    StripeStatus,
    Subscription,
    SubscriptionBilling,
} from '../model/types';

const DIRECTIONS = ['upgrade', 'downgrade'] as const;

const readPlanFields = shapeOf({
    id: field.str(''),
    name: field.str(''),
    description: field.strOrNull,
    price: field.num(0),
    currency: field.str('eur'),
    billing_interval: field.str('monthly'),
    trial_days: field.num(0),
    max_users: field.numOrNull,
    max_agents: field.numOrNull,
    max_knowledge_sources: field.numOrNull,
    per_seat: field.bool(false),
    has_stripe_price: field.bool(false),
    direction: field.oneOfOrNull(DIRECTIONS),
});

function readPlan(raw: unknown): Plan {
    const p = readPlanFields(raw);
    return {
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        currency: p.currency,
        billingInterval: p.billing_interval,
        trialDays: p.trial_days,
        maxUsers: p.max_users,
        maxAgents: p.max_agents,
        maxKnowledgeSources: p.max_knowledge_sources,
        perSeat: p.per_seat,
        hasStripePrice: p.has_stripe_price,
        direction: p.direction,
    };
}

/** A plan list; a row without an id cannot be bought and is dropped. */
export function readPlans(raw: unknown): Plan[] {
    return Array.isArray(raw) ? raw.map(readPlan).filter((p) => p.id) : [];
}

const readLimitFields = shapeOf({
    max_cost_per_month: field.numOrNull,
    max_users: field.numOrNull,
    max_agents: field.numOrNull,
    max_knowledge_sources: field.numOrNull,
});

function readLimits(raw: unknown): PlanLimits {
    const l = readLimitFields(raw);
    return {
        maxCostPerMonth: l.max_cost_per_month,
        maxUsers: l.max_users,
        maxAgents: l.max_agents,
        maxKnowledgeSources: l.max_knowledge_sources,
    };
}

const readBillingFields = nullable(
    shapeOf({
        plan_price: field.numOrNull,
        plan_currency: field.str('EUR'),
        billing_interval: field.str('monthly'),
        per_seat: field.bool(false),
        seat_quantity: field.numOrNull,
        subscription_total: field.num(0),
        usage_pooled: field.bool(true),
        per_user_cap: field.numOrNull,
    }),
);

function readBilling(raw: unknown): SubscriptionBilling | null {
    const b = readBillingFields(raw);
    if (!b) return null;
    return {
        planPrice: b.plan_price,
        planCurrency: b.plan_currency,
        billingInterval: b.billing_interval,
        perSeat: b.per_seat,
        seatQuantity: b.seat_quantity,
        subscriptionTotal: b.subscription_total,
        usagePooled: b.usage_pooled,
        perUserCap: b.per_user_cap,
    };
}

const readSubscriptionFields = shapeOf({
    plan_id: field.strOrNull,
    plan_name: field.strOrNull,
    status: field.str(''),
    payment_status: field.strOrNull,
    stripe_customer_id: field.strOrNull,
    stripe_subscription_id: field.strOrNull,
    billing_cycle_start: field.strOrNull,
    cancel_at_period_end: field.bool(false),
    cancel_at: field.strOrNull,
    current_period_end: field.strOrNull,
    pending_plan_id: field.strOrNull,
    pending_plan_effective: field.strOrNull,
    pending_plan_name: field.strOrNull,
    notes: field.strOrNull,
    effective_limits: readLimits,
    billing: readBilling,
    current_usage: (value: unknown) => field.num(0)(pick(value, 'cost')),
    changeable_plans: readPlans,
});

/** The org's subscription, or null when there is none (the route answers 404). */
export function readSubscription(raw: unknown): Subscription | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const s = readSubscriptionFields(raw);
    return {
        planId: s.plan_id,
        planName: s.plan_name,
        status: s.status,
        paymentStatus: s.payment_status,
        stripeCustomerId: s.stripe_customer_id,
        stripeSubscriptionId: s.stripe_subscription_id,
        billingCycleStart: s.billing_cycle_start,
        cancelAtPeriodEnd: s.cancel_at_period_end,
        cancelAt: s.cancel_at,
        currentPeriodEnd: s.current_period_end,
        pendingPlanId: s.pending_plan_id,
        pendingPlanEffective: s.pending_plan_effective,
        pendingPlanName: s.pending_plan_name,
        notes: s.notes,
        limits: s.effective_limits,
        billing: s.billing,
        usageCost: s.current_usage,
        changeablePlans: s.changeable_plans,
    };
}

export const readStripeStatus: (raw: unknown) => StripeStatus = shapeOf({
    enabled: field.bool(false),
    testMode: field.bool(false),
});

export const readCheckoutStart: (raw: unknown) => CheckoutStart = shapeOf({
    url: field.strOrNull,
    sessionId: field.strOrNull,
});

/** POST /api/stripe/portal answers `{ url }`. */
export const readPortalUrl: (raw: unknown) => string | null = (raw) => field.strOrNull(pick(raw, 'url'));

const readSessionFields = shapeOf({ status: field.strOrNull, subscription_status: field.strOrNull });

export function readCheckoutSession(raw: unknown): CheckoutSession {
    const s = readSessionFields(raw);
    return { status: s.status, subscriptionStatus: s.subscription_status };
}

const readPreviewFields = shapeOf({
    direction: field.oneOf(DIRECTIONS, 'upgrade'),
    currency: field.str('EUR'),
    plan_name: field.strOrNull,
    per_seat: field.bool(false),
    seat_quantity: field.num(1),
    next_renewal_total: field.num(0),
    proration_amount: field.num(0),
    effective: field.strOrNull,
});

export function readPlanChangePreview(raw: unknown): PlanChangePreview {
    const p = readPreviewFields(raw);
    return {
        direction: p.direction,
        currency: p.currency,
        planName: p.plan_name,
        perSeat: p.per_seat,
        seatQuantity: p.seat_quantity,
        nextRenewalTotal: p.next_renewal_total,
        prorationAmount: p.proration_amount,
        effective: p.effective,
    };
}

const readInvoiceRows = shapeListOf({
    id: field.str(''),
    number: field.strOrNull,
    created: field.strOrNull,
    amountPaid: field.numOrNull,
    amountDue: field.numOrNull,
    currency: field.str('EUR'),
    status: field.str(''),
    invoicePdf: field.strOrNull,
});

/** `{ invoices }`; an invoice without an id cannot be opened and is dropped. */
export function readInvoices(raw: unknown): Invoice[] {
    return readInvoiceRows(pick(raw, 'invoices')).filter((inv) => inv.id);
}
