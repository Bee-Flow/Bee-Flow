/**
 * One shape and one formatter for subscription plans.
 *
 * Plans arrive from three endpoints with three different casings —
 * `/api/billing/public-plans` (camelCase), `/api/stripe/plans` and the admin
 * `/api/subscriptions/plans` (snake_case DB rows) — and each consumer grew its
 * own price formatter and currency-symbol map. Those copies disagreed: one
 * rendered "€ 29,-", another "€29/mo", a third "29 EUR per month", and only one
 * of them handled per-seat plans.
 *
 * normalizePlan() is the seam. Everything downstream (PlanCard, PlanGrid, the
 * signup wizard's plan step, the billing page) reads the normalized shape.
 */

/** A plan as each of the three endpoints sends it (camelCase or snake_case). */
export interface RawPlan {
    id?: string;
    plan_id?: string;
    planId?: string;
    name?: string;
    plan_name?: string;
    planName?: string;
    description?: string;
    price?: number | string;
    amount?: number | string;
    currency?: string;
    interval?: string;
    billing_interval?: string;
    billingInterval?: string;
    planType?: string;
    plan_type?: string;
    tier?: string | null;
    plan_tier?: string | null;
    perSeat?: boolean;
    per_seat?: boolean;
    billingModel?: string;
    billing_model?: string;
    trialDays?: number | string;
    trial_days?: number | string;
    isDefault?: boolean;
    is_default?: boolean;
    isPublic?: boolean;
    is_public?: boolean;
    features?: PlanFeature[] | string;
    stripePriceId?: string | null;
    stripe_price_id?: string | null;
}

type PlanFeature = string | { label?: string };

export interface NormalizedPlan {
    id: string | undefined;
    name: string;
    description: string;
    price: number;
    currency: string;
    interval: 'month' | 'year';
    planType: 'organization' | 'consumer';
    tier: string | null;
    perSeat: boolean;
    billingModel: string;
    trialDays: number;
    isDefault: boolean;
    isPublic: boolean;
    features: PlanFeature[];
    stripePriceId: string | null;
    isFree: boolean;
    raw: RawPlan;
}

export type Translate = (key: string, fallback: string) => string;

export interface PriceParts {
    amount: string;
    period: string;
    free: boolean;
    metered?: boolean;
}

const CURRENCY_SYMBOLS: Record<string, string> = { eur: '€', usd: '$', gbp: '£' };

/** @returns {string} the symbol for a currency code, or the upper-cased code. */
export function currencySymbol(currency?: string | null): string {
    const c = String(currency || 'eur').toLowerCase();
    return CURRENCY_SYMBOLS[c] || c.toUpperCase();
}

/**
 * Fold any of the three plan wire-shapes into one.
 */
export function normalizePlan(raw: RawPlan | null | undefined): NormalizedPlan | null {
    if (!raw) return null;
    const price = Number(raw.price ?? raw.amount ?? 0) || 0;
    const features = Array.isArray(raw.features)
        ? raw.features
        : (typeof raw.features === 'string' ? safeParseArray(raw.features) : []);

    return {
        id: raw.id ?? raw.plan_id ?? raw.planId,
        name: raw.name ?? raw.plan_name ?? raw.planName ?? '',
        description: raw.description ?? '',
        price,
        currency: String(raw.currency ?? 'eur').toLowerCase(),
        interval: normalizeInterval(raw.interval ?? raw.billing_interval ?? raw.billingInterval),
        planType: (raw.planType ?? raw.plan_type) === 'consumer' ? 'consumer' : 'organization',
        tier: raw.tier ?? raw.plan_tier ?? null,
        perSeat: !!(raw.perSeat ?? raw.per_seat),
        billingModel: raw.billingModel ?? raw.billing_model ?? 'fixed',
        trialDays: Number(raw.trialDays ?? raw.trial_days ?? 0) || 0,
        isDefault: !!(raw.isDefault ?? raw.is_default),
        isPublic: (raw.isPublic ?? raw.is_public) !== false,
        features,
        stripePriceId: raw.stripePriceId ?? raw.stripe_price_id ?? null,
        isFree: price <= 0,
        raw,
    };
}

function safeParseArray(s: string): PlanFeature[] {
    try {
        const v = JSON.parse(s);
        return Array.isArray(v) ? v : [];
    } catch { return []; }
}

function normalizeInterval(v?: string): 'month' | 'year' {
    const s = String(v || 'month').toLowerCase();
    return (s === 'year' || s === 'yearly' || s === 'annual') ? 'year' : 'month';
}

/**
 * Render a plan's price. Returns the parts rather than a single string so a card
 * can size the amount differently from the period — callers that just want text
 * can join them.
 */
export function formatPrice(plan: NormalizedPlan | null | undefined, t: Translate): PriceParts {
    if (!plan) return { amount: '', period: '', free: false };
    if (plan.isFree) {
        return { amount: t('billing.free', 'Free'), period: '', free: true };
    }

    const sym = currencySymbol(plan.currency);
    // Whole amounts read better without trailing zeroes; 9.99 must keep them.
    const n = Number.isInteger(plan.price) ? String(plan.price) : plan.price.toFixed(2);
    const per = plan.interval === 'year'
        ? t('billing.per_year', '/year')
        : t('billing.per_month', '/month');
    const seat = plan.perSeat ? ` ${t('billing.per_seat', 'per seat')}` : '';

    return {
        amount: `${sym}${n}`,
        period: `${per}${seat}`,
        free: false,
        metered: plan.billingModel === 'metered',
    };
}

/** Single-string form, for aria-labels and compact contexts. */
export function formatPriceText(plan: NormalizedPlan | null | undefined, t: Translate): string {
    const p = formatPrice(plan, t);
    return p.free ? p.amount : `${p.amount}${p.period}`;
}

/**
 * Split a plan list into the two audiences. Used by the billing page and the
 * signup wizard's plan step, which each only ever show one group.
 */
export function groupPlans(plans: RawPlan[] | null | undefined) {
    const list = (plans || []).map(normalizePlan).filter(Boolean) as NormalizedPlan[];
    return {
        organization: list.filter(p => p.planType === 'organization'),
        consumer: list.filter(p => p.planType === 'consumer'),
    };
}

/** Plans a given account type can actually buy, cheapest first. */
export function plansFor(plans: RawPlan[] | null | undefined, accountType?: string): NormalizedPlan[] {
    const groups = groupPlans(plans);
    const list = accountType === 'consumer' ? groups.consumer : groups.organization;
    return list.filter(p => p.isPublic).sort((a, b) => a.price - b.price);
}
