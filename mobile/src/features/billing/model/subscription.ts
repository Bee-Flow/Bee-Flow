/**
 * What the License & Usage screen shows for a subscription: the web's
 * OrgLicenseSection.jsx conditions, lifted out of its JSX into pure rules so
 * the phone decides the same way. Each names the web block it ports.
 */

import { formatNumber } from '@/core/i18n';

import type { Plan, PlanLimits, Subscription } from './types';

/**
 * utils/billing.js PORTAL_ELIGIBLE_PAYMENT_STATUSES, kept in step with the
 * server's gate in routes/stripe/portal.js (billing.lockstep.test.ts).
 */
export const PORTAL_ELIGIBLE_PAYMENT_STATUSES: readonly string[] = [
    'paid', 'past_due', 'paused', 'disputed', 'failed', 'refunded',
];

/** utils/billing.js hasPaidBillingRelationship: may this org open the Customer Portal? */
export function hasPaidBillingRelationship(sub: Pick<Subscription, 'stripeCustomerId' | 'paymentStatus'> | null): boolean {
    if (!sub?.stripeCustomerId) return false;
    return PORTAL_ELIGIBLE_PAYMENT_STATUSES.includes(sub.paymentStatus ?? '');
}

/** orgInfoShared.jsx currencySym: a three-letter code to its glyph. */
export function currencySymbol(code: string | null | undefined): string {
    const upper = String(code || 'EUR').toUpperCase();
    return ({ EUR: '€', USD: '$', GBP: '£' } as Record<string, string>)[upper] ?? (code || '€');
}

export function money(amount: number, currency: string | null | undefined): string {
    return `${currencySymbol(currency)}${amount.toFixed(2)}`;
}

/** A cap the plan sets at all: not absent, not -1 (unlimited). The header and the sharing switch ask this. */
export function costCapSet(limits: PlanLimits): boolean {
    return limits.maxCostPerMonth !== null && limits.maxCostPerMonth !== -1;
}

/** A cap a percentage can be taken of: set, and not 0. */
export function hasCostCap(limits: PlanLimits): boolean {
    return costCapSet(limits) && limits.maxCostPerMonth !== 0;
}

/** orgCostPct: AI cost as a whole percentage of the cap, at most 100; 0 without a cap. */
export function costPercent(sub: Pick<Subscription, 'limits' | 'usageCost'>): number {
    if (!hasCostCap(sub.limits)) return 0;
    return Math.min(100, Math.round((sub.usageCost / (sub.limits.maxCostPerMonth as number)) * 100));
}

/** showOrgUpgradeCta: the usage nudge at 80 % of the cap. */
export function showUpgradeNudge(sub: Pick<Subscription, 'limits' | 'usageCost'>): boolean {
    return costPercent(sub) >= 80;
}

/** The heading: "Subscription & Usage" for a real paid subscription, "License & Usage" otherwise. */
export function isPaidSubscription(sub: Subscription | null): boolean {
    return Boolean(sub?.stripeSubscriptionId || (sub?.billing?.subscriptionTotal ?? 0) > 0);
}

/** Nothing is being unwound: no cancellation and no scheduled downgrade. */
function settledTerms(sub: Subscription): boolean {
    return !sub.cancelAtPeriodEnd && !sub.pendingPlanId;
}

/** The Change plan picker: a Stripe subscription with somewhere to go. */
export function canChangePlan(sub: Subscription): boolean {
    return Boolean(sub.stripeSubscriptionId) && sub.changeablePlans.length > 0 && settledTerms(sub);
}

/** "You're on the highest plan": paying, and the server offers nothing else. */
export function onHighestPlan(sub: Subscription): boolean {
    return (
        Boolean(sub.stripeSubscriptionId) &&
        (sub.billing?.subscriptionTotal ?? 0) > 0 &&
        sub.changeablePlans.length === 0 &&
        settledTerms(sub)
    );
}

/** A free or manual plan subscribes through Stripe Checkout; so does no plan at all. */
export function canSubscribe(sub: Subscription | null, plans: readonly Plan[]): boolean {
    return !sub?.stripeSubscriptionId && plans.length > 0;
}

/** The muted Cancel under the billing card. */
export function canCancel(sub: Subscription): boolean {
    return Boolean(sub.stripeSubscriptionId) && sub.status === 'active' && !sub.cancelAtPeriodEnd;
}

/** The AI usage sharing switch: only a real cost budget can be split. */
export function showUsageSharing(sub: Subscription | null): boolean {
    return Boolean(sub) && costCapSet((sub as Subscription).limits);
}

/** The post-checkout wait is over: Stripe manages it and it is live. */
export function isSettled(sub: Subscription | null): boolean {
    return Boolean(sub?.stripeSubscriptionId) && (sub?.status === 'active' || sub?.status === 'trialing');
}

export type LimitKey = 'users' | 'agents' | 'knowledge';

export interface LimitItem {
    key: LimitKey;
    /** Users show live seats against the cap when the plan is per seat. */
    value: string;
}

const cap = (n: number | null) => n !== null && n !== -1;

/** The plan limits card: only concrete caps, never an "∞" tile. */
export function limitItems(sub: Subscription): LimitItem[] {
    const { limits, billing } = sub;
    const items: LimitItem[] = [];
    if (cap(limits.maxUsers)) {
        const max = formatNumber(limits.maxUsers as number);
        items.push({ key: 'users', value: billing?.seatQuantity != null ? `${billing.seatQuantity} / ${max}` : max });
    }
    if (cap(limits.maxAgents)) items.push({ key: 'agents', value: formatNumber(limits.maxAgents as number) });
    if (cap(limits.maxKnowledgeSources)) {
        items.push({ key: 'knowledge', value: formatNumber(limits.maxKnowledgeSources as number) });
    }
    return items;
}

/** A plan card's caps line: "10 users · 5 agents · 20 KB sources" parts, unlimited ones left out. */
export function planCaps(plan: Plan): { users: number | null; agents: number | null; knowledge: number | null } {
    const pick = (n: number | null) => (n && n !== -1 ? n : null);
    return { users: pick(plan.maxUsers), agents: pick(plan.maxAgents), knowledge: pick(plan.maxKnowledgeSources) };
}
