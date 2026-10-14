/** Shapes of the consumer billing endpoints and the helpers that read them. */

export interface ConsumerPlan {
    id: string;
    name?: string;
    description?: string;
    price?: number | string;
    currency?: string;
    billing_model?: string;
    billing_interval?: string;
    trial_days?: number;
    max_agents?: number;
    max_knowledge_sources?: number;
}

export interface ConsumerSubscription {
    status?: string;
    payment_status?: string;
    plan_id?: string;
    stripe_customer_id?: string;
    [key: string]: unknown;
}

export interface ConsumerUsageData {
    limits?: {
        plan_name?: string;
        max_cost_per_month?: number | null;
        max_agents?: number | null;
        max_knowledge_sources?: number | null;
    } | null;
    usage?: { total_billed_cost?: number | string } | null;
    billing_period?: { end?: string } | null;
    subscription?: ConsumerSubscription | null;
}

export type CheckoutMessage = { type: 'success' | 'cancelled' | 'error'; text: string };

export const currencySymbol = (c?: string) => ({ EUR: '€', USD: '$', GBP: '£' } as Record<string, string>)[c?.toUpperCase() ?? ''] || '€';

/**
 * A paid digital service (or a metered one): starting it immediately needs
 * the consumer to waive the 14-day right of withdrawal.
 */
export const isPaidPlan = (plan: ConsumerPlan) => Number(plan.price) > 0 || plan.billing_model === 'metered';

export const isUnlimitedLimit = (val: number | null | undefined) => val === null || val === undefined || val === -1;

/** 1.2M / 3.4K / 999 — or ∞ for no limit. */
export function formatCompact(val: number | null | undefined): string {
    if (val === null || val === undefined || val === -1) return '∞';
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
    return val.toLocaleString();
}

/** Whole days left until `end`, never negative; null without an end. */
export function daysUntil(end: string | undefined, now = new Date()): number | null {
    const periodEnd = end ? new Date(end) : null;
    return periodEnd ? Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))) : null;
}
