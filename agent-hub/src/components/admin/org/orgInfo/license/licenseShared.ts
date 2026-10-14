/**
 * Shapes of the subscription endpoints as the License & Usage page reads
 * them (GET /api/subscriptions/orgs/:id, GET /api/stripe/plans and
 * POST …/preview-change). Only what the page reads is named; the server owns
 * the rest.
 */
import { useTranslation } from '../../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { formatDate } from '../../../../../utils/dateFormatters';

/** A sellable plan: an offer on the checkout list, or a target to change to. */
export interface BillingPlan {
    id: string;
    name?: string;
    description?: string;
    currency?: string;
    price: number | string;
    billing_interval?: string;
    trial_days?: number;
    has_stripe_price?: boolean;
    max_users?: number | null;
    max_agents?: number | null;
    max_knowledge_sources?: number | null;
    per_seat?: boolean;
    /** Only on changeable plans: which way the change goes. */
    direction?: 'upgrade' | 'downgrade' | string;
    [key: string]: unknown;
}

export interface PlanLimits {
    max_cost_per_month?: number | null;
    max_users?: number | null;
    max_agents?: number | null;
    max_knowledge_sources?: number | null;
}

export interface SubscriptionBilling {
    subscription_total?: number | string;
    per_seat?: boolean;
    plan_currency?: string;
    plan_price?: number | string;
    billing_interval?: string;
    seat_quantity?: number | null;
}

export interface OrgSubscription {
    plan_name?: string;
    status?: string;
    payment_status?: string;
    billing_cycle_start?: string | null;
    stripe_subscription_id?: string | null;
    stripe_customer_id?: string | null;
    changeable_plans?: BillingPlan[];
    cancel_at_period_end?: boolean;
    cancel_at?: string | null;
    pending_plan_id?: string | null;
    pending_plan_name?: string | null;
    pending_plan_effective?: string | null;
    effective_limits?: PlanLimits;
    current_usage?: { cost?: number };
    billing?: SubscriptionBilling | null;
    notes?: string | null;
    [key: string]: unknown;
}

/** The prorated cost of a plan change, before it is committed. */
export interface ChangePreview {
    direction?: string;
    currency?: string;
    next_renewal_total?: number | string;
    effective?: string | null;
    proration_amount?: number | string;
    per_seat?: boolean;
    seat_quantity?: number;
}

/** A subscription action's outcome, shown inline until dismissed. */
export interface SubMessage {
    type: 'success' | 'error';
    text: string;
}

/** The org form's fields this page touches (the usage-sharing toggle). */
export interface OrgUsageData {
    usagePooled?: boolean;
}

/** € / £ / $ for a plan's currency (EUR when unset). */
export function planCurrencySymbol(currency: string | undefined, fallback = 'eur'): string {
    const code = (currency || fallback).toUpperCase();
    return code === 'EUR' ? '€' : code === 'GBP' ? '£' : '$';
}

/** The API sends 'monthly' | 'yearly'; show the translated period. */
export function intervalLabel(t: TranslateFn, iv: string | undefined): string {
    return iv === 'yearly' ? t('org.year', 'year') : t('org.month', 'month');
}

/** A cap is real when it is set and not -1 (unlimited). */
export function isFiniteCap(v: number | null | undefined): v is number {
    return v !== null && v !== undefined && v !== -1;
}

/** t, and dates in the UI language rather than a fixed one. */
export function useLicenseText(): { t: TranslateFn; fmtDate: (d: string) => string } {
    const { t, resolvedLocale } = useTranslation();
    return { t, fmtDate: (d: string) => formatDate(d, { locale: resolvedLocale || 'en' }) };
}
