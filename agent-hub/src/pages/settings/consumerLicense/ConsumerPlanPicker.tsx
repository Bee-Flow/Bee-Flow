import { ArrowUpRight, Check, CreditCard, Loader2 } from 'lucide-react';
import type { RefObject } from 'react';
import { BILLING_ACTION } from '../../../components/billing/billingTheme';
import { useTranslation } from '../../../hooks/useTranslation';
import { currencySymbol, isPaidPlan, type ConsumerPlan } from './consumerBilling';
import type { ConsumerBilling } from './useConsumerBilling';

/** The plan's price, trial and feature highlights. */
function PlanFacts({ plan }: { plan: ConsumerPlan }) {
    const { t } = useTranslation();
    return (
        <>
            {plan.description && (
                <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">{plan.description}</p>
            )}
            <div className="flex items-baseline gap-1 mb-3">
                <span className="text-2xl font-extrabold text-[var(--text-primary)]">
                    {currencySymbol(plan.currency)}{Number(plan.price).toFixed(2)}
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                    / {plan.billing_interval === 'yearly' ? 'year' : 'month'}
                </span>
            </div>
            {(plan.trial_days ?? 0) > 0 && (
                <div className="text-[11px] font-semibold text-emerald-500 mb-3">
                    {t('settings.consumer_license.trial_days', '{days}-day free trial', { days: plan.trial_days })}
                </div>
            )}
            {/* Feature highlights */}
            <div className="space-y-1.5 mb-4">
                {plan.max_agents && (
                    <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                        <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                        {t('settings.consumer_license.plan_agents', '{count} agents', { count: plan.max_agents })}
                    </div>
                )}
                {plan.max_knowledge_sources && (
                    <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                        <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                        {t('settings.consumer_license.plan_knowledge_sources', '{count} knowledge sources', { count: plan.max_knowledge_sources })}
                    </div>
                )}
            </div>
        </>
    );
}

/** The withdrawal waiver (paid plans only) and the order button. */
function PlanCta({ plan, billing, hasActiveSub }: { plan: ConsumerPlan; billing: ConsumerBilling; hasActiveSub: boolean }) {
    const { t } = useTranslation();
    const { checkoutLoading, waiverAccepted } = billing;
    const isPaid = isPaidPlan(plan);
    return (
        <>
            {isPaid && (
                <label className="flex items-start gap-2 mb-2 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={!!waiverAccepted[plan.id]}
                        onChange={e => billing.setWaiver(plan.id, e.target.checked)}
                        className="mt-0.5 w-3.5 h-3.5 shrink-0"
                        style={{ accentColor: 'var(--accent-primary)' }}
                    />
                    <span className="text-[10px] leading-snug text-[var(--text-muted)]">
                        {t('checkout.withdrawal_waiver_label', 'I request that the service start immediately and acknowledge that I lose my 14-day right of withdrawal once the service has been fully performed.')}
                    </span>
                </label>
            )}
            <button
                onClick={() => billing.handleCheckout(plan)}
                disabled={!!checkoutLoading || (isPaid && !waiverAccepted[plan.id])}
                className="w-full py-2.5 rounded-lg text-xs font-bold text-white transition-all duration-200 flex items-center justify-center gap-1.5 disabled:opacity-50"
                style={{
                    background: BILLING_ACTION,
                    opacity: checkoutLoading && checkoutLoading !== plan.id ? 0.5 : 1,
                    cursor: checkoutLoading ? 'wait' : 'pointer',
                }}
            >
                {checkoutLoading === plan.id ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Redirecting...</>
                ) : (
                    <><ArrowUpRight className="w-3.5 h-3.5" /> {isPaid ? t('checkout.order_with_obligation', 'Order with obligation to pay') : (hasActiveSub ? 'Switch Plan' : 'Subscribe')}</>
                )}
            </button>
            {/* BFSF-243: recurring-billing disclosure right at the CTA */}
            <div className="mt-1.5 flex justify-center">
                <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-amber-500/15 text-amber-500">
                    {t('billing.recurring_badge', 'Recurring · automatische incasso')}
                </span>
            </div>
        </>
    );
}

interface PlanOptionProps {
    plan: ConsumerPlan;
    billing: ConsumerBilling;
    isCurrentPlan: boolean;
    isPreselected: boolean;
    hasActiveSub: boolean;
    preselectedRef: RefObject<HTMLDivElement | null>;
}

/** One plan card in the picker. */
function PlanOption({ plan, billing, isCurrentPlan, isPreselected, hasActiveSub, preselectedRef }: PlanOptionProps) {
    const { t } = useTranslation();
    return (
        <div
            ref={isPreselected ? preselectedRef : null}
            className="relative rounded-xl border overflow-hidden transition-all duration-200 min-w-0"
            style={{
                // "You're on this plan" is a success state, so it uses the
                // --success token. A deep-linked preselection is an attention
                // state, so it borrows the billing-action blue instead.
                borderColor: isCurrentPlan ? 'var(--success)'
                    : isPreselected ? BILLING_ACTION
                        : 'var(--border-subtle)',
                background: isCurrentPlan
                    ? 'color-mix(in srgb, var(--success) 4%, var(--bg-secondary))'
                    : 'var(--bg-secondary)',
                boxShadow: isPreselected ? `0 0 0 1px ${BILLING_ACTION}` : undefined,
            }}
        >
            {isCurrentPlan && <div className="absolute top-0 left-0 right-0 h-1 bg-[var(--success)]" />}
            <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-bold text-[var(--text-primary)]">{plan.name}</h4>
                    {isCurrentPlan && (
                        <span
                            className="text-[9px] font-bold px-2 py-0.5 rounded-full uppercase"
                            style={{ color: 'var(--success)', background: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
                        >
                            {t('billing.current_plan', 'Current plan')}
                        </span>
                    )}
                </div>
                <PlanFacts plan={plan} />
                {isCurrentPlan ? (
                    <button
                        disabled
                        className="w-full py-2 rounded-lg text-xs font-semibold border"
                        style={{
                            color: 'var(--success)',
                            borderColor: 'color-mix(in srgb, var(--success) 30%, transparent)',
                            background: 'color-mix(in srgb, var(--success) 6%, transparent)',
                            cursor: 'default',
                        }}
                    >
                        <Check className="w-3.5 h-3.5 inline mr-1" /> {t('billing.your_plan', 'Your plan')}
                    </button>
                ) : (
                    <PlanCta plan={plan} billing={billing} hasActiveSub={hasActiveSub} />
                )}
            </div>
        </div>
    );
}

/** Subscription plans / upgrade. */
export default function ConsumerPlanPicker({ billing, hasActiveSub, currentPlanId }: { billing: ConsumerBilling; hasActiveSub: boolean; currentPlanId?: string }) {
    const { t } = useTranslation();
    const { plans, preselectedPlanId, preselectedRef } = billing;
    return (
        <div id="consumer-plan-picker" className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5">
            <div className="flex items-center gap-2 mb-4">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    {hasActiveSub ? 'Change Plan' : 'Upgrade Your Plan'}
                </h3>
            </div>

            {/* BFSF-243: recurring-billing (automatische incasso) disclosure */}
            <div className="flex items-start gap-2 mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <CreditCard className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                <p className="text-[11.5px] leading-snug text-[var(--text-secondary)]">
                    {t('billing.recurring_notice', 'This is a recurring subscription. Your selected payment method is charged automatically at the start of each billing period (automatische incasso) until you cancel.')}
                </p>
            </div>

            {/* Responsive columns: a fixed `repeat(min(n,3), 1fr)` kept three
                plans in three columns down to phone width. `min-w-0` on each
                card keeps long plan names from forcing a horizontal scroll. */}
            <div className={`grid gap-4 ${plans.length === 1 ? 'grid-cols-1'
                : plans.length === 2 ? 'grid-cols-1 sm:grid-cols-2'
                    : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'}`}>
                {plans.map(plan => {
                    const isCurrentPlan = hasActiveSub && currentPlanId === plan.id;
                    return (
                        <PlanOption
                            key={plan.id}
                            plan={plan}
                            billing={billing}
                            isCurrentPlan={isCurrentPlan}
                            isPreselected={!isCurrentPlan && plan.id === preselectedPlanId}
                            hasActiveSub={hasActiveSub}
                            preselectedRef={preselectedRef}
                        />
                    );
                })}
            </div>

            {/* Promo code hint */}
            <p className="text-[11px] text-[var(--text-muted)] text-center mt-4">
                {t('settings.consumer_license.promo_hint', 'Have a promo code? You can apply it during checkout.')}
            </p>
        </div>
    );
}
