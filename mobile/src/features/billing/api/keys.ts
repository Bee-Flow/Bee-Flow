/** Query keys for the organisation's subscription and its Stripe reads. */

export const billingKeys = {
    all: ['billing'] as const,
    subscription: (orgId: string) => ['billing', 'subscription', orgId] as const,
    stripeStatus: ['billing', 'stripe-status'] as const,
    plans: ['billing', 'plans'] as const,
    invoices: ['billing', 'invoices'] as const,
};
