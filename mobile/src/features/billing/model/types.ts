/**
 * The organisation's subscription and its Stripe hand-offs, as the server
 * serialises them. Each shape names the file it was read from.
 */

/** A plan in either picker (routes/stripe/plans.js, subscriptions/orgSubscriptions.js). */
export interface Plan {
    id: string;
    name: string;
    description: string | null;
    price: number;
    /** Lower-case on the plan rows ('eur'); the glyph reader ignores case. */
    currency: string;
    /** 'monthly' | 'yearly'. */
    billingInterval: string;
    trialDays: number;
    maxUsers: number | null;
    maxAgents: number | null;
    maxKnowledgeSources: number | null;
    perSeat: boolean;
    /** False: the plan has no Stripe price, so it cannot be bought here. */
    hasStripePrice: boolean;
    /** Only on `changeable_plans`: which way the change goes. */
    direction: 'upgrade' | 'downgrade' | null;
}

/** `effective_limits`: -1 or null means no cap. */
export interface PlanLimits {
    maxCostPerMonth: number | null;
    maxUsers: number | null;
    maxAgents: number | null;
    maxKnowledgeSources: number | null;
}

/** `billing`, present when the subscription has a plan. */
export interface SubscriptionBilling {
    planPrice: number | null;
    planCurrency: string;
    billingInterval: string;
    perSeat: boolean;
    seatQuantity: number | null;
    subscriptionTotal: number;
    usagePooled: boolean;
    perUserCap: number | null;
}

/** `GET /api/subscriptions/orgs/:orgId` (subscriptions/orgSubscriptions.js). */
export interface Subscription {
    planId: string | null;
    planName: string | null;
    /** 'active' | 'trialing' | 'past_due' | 'suspended' | 'cancelled' | … */
    status: string;
    paymentStatus: string | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    billingCycleStart: string | null;
    cancelAtPeriodEnd: boolean;
    cancelAt: string | null;
    currentPeriodEnd: string | null;
    pendingPlanId: string | null;
    pendingPlanEffective: string | null;
    pendingPlanName: string | null;
    notes: string | null;
    limits: PlanLimits;
    billing: SubscriptionBilling | null;
    /** The marked-up AI cost this period; members never see tokens. */
    usageCost: number;
    changeablePlans: Plan[];
}

/** `GET /api/stripe/status`. */
export interface StripeStatus {
    enabled: boolean;
    testMode: boolean;
}

/** `POST /api/stripe/checkout` → the hosted Checkout page and its session. */
export interface CheckoutStart {
    url: string | null;
    sessionId: string | null;
}

/** `GET /api/stripe/sessions/:id`, the part the return reads. */
export interface CheckoutSession {
    /** 'open' | 'complete' | 'expired'. */
    status: string | null;
    subscriptionStatus: string | null;
}

/** `POST /api/subscriptions/orgs/:orgId/preview-change` (subscriptions/lifecycle.js). */
export interface PlanChangePreview {
    direction: 'upgrade' | 'downgrade';
    currency: string;
    planName: string | null;
    perSeat: boolean;
    seatQuantity: number;
    nextRenewalTotal: number;
    prorationAmount: number;
    /** 'now' for an upgrade, the period end (ISO) for a downgrade. */
    effective: string | null;
}

/** One row of `GET /api/stripe/invoices` (services/stripeService.js listInvoices). */
export interface Invoice {
    id: string;
    number: string | null;
    created: string | null;
    amountPaid: number | null;
    amountDue: number | null;
    currency: string;
    /** 'paid' | 'open' | 'uncollectible' | 'void'. */
    status: string;
    invoicePdf: string | null;
}
