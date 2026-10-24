import { ArrowRight, CreditCard, Loader2, Zap } from 'lucide-react';
import { intervalLabel, planCurrencySymbol, useLicenseText } from './licenseShared';
import type { BillingPlan } from './licenseShared';

interface CheckoutProps {
    plans: BillingPlan[];
    checkoutLoading: string | null;
    onCheckout: (planId: string) => void;
}

/**
 * The recurring-billing (automatische incasso) disclosure, shown above every
 * list of plans that leads to a Stripe checkout (BFSF-243).
 */
export function RecurringNotice() {
    const { t } = useLicenseText();
    return (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <CreditCard className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
            <p className="text-[11px] leading-snug text-[var(--text-secondary)]">
                {t('billing.recurring_notice', 'This is a recurring subscription. Your selected payment method is charged automatically at the start of each billing period (automatische incasso) until you cancel.')}
            </p>
        </div>
    );
}

/** The plan's caps as small labels; unlimited (-1) and unset caps are left out. */
export function PlanCaps({ plan }: { plan: BillingPlan }) {
    const { t } = useLicenseText();
    return (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--text-muted)]">
            {plan.max_users && plan.max_users !== -1 && <span>{t('admin_org.license_max_users', '{n} users', { n: plan.max_users })}</span>}
            {plan.max_agents && plan.max_agents !== -1 && <span>{t('admin_org.license_max_agents', '{n} agents', { n: plan.max_agents })}</span>}
            {plan.max_knowledge_sources && plan.max_knowledge_sources !== -1 && <span>{t('admin_org.license_max_kb', '{n} KB sources', { n: plan.max_knowledge_sources })}</span>}
        </div>
    );
}

function TrialBadge({ days }: { days: number }) {
    const { t } = useLicenseText();
    return (
        <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-green-500/15 text-green-500">
            {t('admin_org.license_free_trial_days', '{days}d free trial', { days })}
        </span>
    );
}

function CheckoutPlanCard({ plan, checkoutLoading, onCheckout }: Omit<CheckoutProps, 'plans'> & { plan: BillingPlan }) {
    const { t } = useLicenseText();
    const currencySymbol = planCurrencySymbol(plan.currency);
    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 hover:border-[var(--accent-primary)] transition-colors">
            <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <h4 className="text-sm font-bold text-[var(--text-primary)]">{plan.name}</h4>
                        {(plan.trial_days ?? 0) > 0 && <TrialBadge days={plan.trial_days as number} />}
                    </div>
                    {plan.description && <p className="text-[11px] text-[var(--text-muted)] mb-2">{plan.description}</p>}
                    <PlanCaps plan={plan} />
                </div>
                <div className="flex items-center gap-3 ml-4">
                    <div className="text-right">
                        <div className="text-lg font-bold text-[var(--text-primary)]">{currencySymbol}{(plan.price as number).toFixed(2)}</div>
                        <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider">/ {intervalLabel(t, plan.billing_interval)}</div>
                    </div>
                    <button
                        onClick={() => onCheckout(plan.id)}
                        disabled={checkoutLoading === plan.id || !plan.has_stripe_price}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 [background:#3b82f6]"
                    >
                        {checkoutLoading === plan.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <ArrowRight className="w-3.5 h-3.5" />
                        )}
                        {t('org.subscribe', 'Subscribe')}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** No subscription yet: the placeholder, and (cloud only) the plans to choose from. */
export function NoSubscriptionOffers({ isCloud, plans, checkoutLoading, onCheckout }: CheckoutProps & { isCloud: boolean }) {
    const { t } = useLicenseText();
    return (
        <div className="space-y-5">
            <div className="p-6 rounded-2xl border-2 border-dashed border-[var(--border-subtle)] text-center">
                <CreditCard className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)] opacity-40" />
                <p className="text-sm font-medium text-[var(--text-primary)]">{t('org.no_license')}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">{t('org.no_license_desc')}</p>
            </div>

            {/* Available plans from Stripe — cloud only; self-hosted uses license keys */}
            {isCloud && plans.length > 0 ? (
                <div>
                    <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                        <Zap className="w-4 h-4 [color:#3b82f6]" />
                        {t('org.choose_plan', 'Choose a Plan')}
                    </h3>
                    <div className="mb-3"><RecurringNotice /></div>
                    <div className="grid gap-3">
                        {plans.map(plan => (
                            <CheckoutPlanCard key={plan.id} plan={plan} checkoutLoading={checkoutLoading} onCheckout={onCheckout} />
                        ))}
                    </div>
                </div>
            ) : isCloud ? (
                <div className="p-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] text-center">
                    <p className="text-sm text-[var(--text-primary)]">{t('org.no_plans_configured', 'No plans are available right now.')}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                        {t('org.contact_for_plan', 'Reach out to')} <a href="mailto:info@beeflow.nl" className="text-[#3b82f6] hover:underline">info@beeflow.nl</a> {t('org.to_get_started', 'to get started.')}
                    </p>
                </div>
            ) : null}
        </div>
    );
}

function PaidUpgradePlanCard({ plan, checkoutLoading, onCheckout }: Omit<CheckoutProps, 'plans'> & { plan: BillingPlan }) {
    const { t } = useLicenseText();
    const sym = planCurrencySymbol(plan.currency);
    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 hover:border-[var(--accent-primary)] transition-colors">
            <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <h4 className="text-sm font-bold text-[var(--text-primary)]">{plan.name}</h4>
                        {(plan.trial_days ?? 0) > 0 && <TrialBadge days={plan.trial_days as number} />}
                    </div>
                    {plan.description && <p className="text-[11px] text-[var(--text-muted)] mb-2">{plan.description}</p>}
                </div>
                <div className="flex items-center gap-3 ml-4">
                    <div className="text-right">
                        <div className="text-lg font-bold text-[var(--text-primary)]">{sym}{Number(plan.price).toFixed(2)}</div>
                        <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider">/ {intervalLabel(t, plan.billing_interval)}{plan.per_seat ? ` ${t('org.per_seat', '/ seat')}` : ''}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                        <button
                            onClick={() => onCheckout(plan.id)}
                            disabled={checkoutLoading === plan.id}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 [background:#3b82f6]"
                        >
                            {checkoutLoading === plan.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
                            {t('org.subscribe', 'Subscribe')}
                        </button>
                        {/* BFSF-243: recurring-billing disclosure right at the CTA */}
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-amber-500/15 text-amber-500 whitespace-nowrap">
                            {t('billing.recurring_badge', 'Recurring · automatische incasso')}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * Subscribe-to-paid section for orgs on a free/manual (non-Stripe) plan.
 * Routes through Stripe Checkout, which establishes the stripe_subscription_id
 * so upgrades/downgrades/billing work after.
 */
export function UpgradeToPaidOffers({ plans, checkoutLoading, onCheckout }: CheckoutProps) {
    const { t } = useLicenseText();
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-3">
            <div className="flex items-center gap-2 mb-1">
                <Zap className="w-4 h-4 [color:#3b82f6]" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('org.upgrade_to_paid', 'Upgrade to a paid plan')}</h3>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                {t('org.upgrade_to_paid_hint', "You're on a free plan. Subscribe to unlock higher usage and more features — you'll be taken to secure Stripe checkout.")}
            </p>
            {/* BFSF-243: recurring-billing (automatische incasso) disclosure */}
            <RecurringNotice />
            <div className="grid gap-3">
                {plans.map(plan => (
                    <PaidUpgradePlanCard key={plan.id} plan={plan} checkoutLoading={checkoutLoading} onCheckout={onCheckout} />
                ))}
            </div>
        </div>
    );
}
