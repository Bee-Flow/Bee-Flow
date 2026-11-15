import { ArrowRight, ExternalLink, Loader2, Zap } from 'lucide-react';
import type { Ref } from 'react';
import { intervalLabel, planCurrencySymbol, useLicenseText } from './licenseShared';
import type { BillingPlan, OrgSubscription, PlanLimits } from './licenseShared';
import { PlanCaps } from './PlanOffers';
import type { OrgSubscriptionState } from './useOrgSubscription';
import { hasPaidBillingRelationship } from '@/utils/billing';
import { CHIP, CHIP_ERROR, CHIP_SUCCESS } from '@/components/shared/adminUi';
import { buttonClass } from '@/components/shared/buttonClasses';

/** The chip of a subscription status: active is good news, a suspension or an open payment action bad. */
function statusChip(status: string | undefined): string {
    if (status === 'active') return CHIP_SUCCESS;
    if (status === 'suspended' || status === 'manual_action_required') return CHIP_ERROR;
    return CHIP;
}

type PickerState = Pick<OrgSubscriptionState, 'handleSelectChange' | 'previewLoading' | 'changeTarget'>;

function ChangePlanCard({ plan, handleSelectChange, previewLoading, changeTarget }: PickerState & { plan: BillingPlan }) {
    const { t } = useLicenseText();
    const sym = planCurrencySymbol(plan.currency);
    const isDown = plan.direction === 'downgrade';
    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 hover:border-[var(--accent-primary)] transition-colors">
            <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <h4 className="text-sm font-bold text-[var(--text-primary)]">{plan.name}</h4>
                        <span className={CHIP}>
                            {isDown ? t('org.downgrade', 'Downgrade') : t('org.upgrade', 'Upgrade')}
                        </span>
                    </div>
                    {plan.description && <p className="text-[11px] text-[var(--text-muted)] mb-2">{plan.description}</p>}
                    <PlanCaps plan={plan} />
                </div>
                <div className="flex items-center gap-3 ml-4">
                    <div className="text-right">
                        <div className="text-lg font-bold text-[var(--text-primary)]">{sym}{Number(plan.price).toFixed(2)}</div>
                        <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider">/ {intervalLabel(t, plan.billing_interval)}</div>
                    </div>
                    <button
                        onClick={() => handleSelectChange(plan)}
                        disabled={previewLoading || !plan.has_stripe_price}
                        className={buttonClass(isDown ? 'secondary' : 'primary', 'md')}
                    >
                        {(previewLoading && changeTarget?.id === plan.id) ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <ArrowRight className="w-3.5 h-3.5" />
                        )}
                        {isDown ? t('org.downgrade', 'Downgrade') : t('org.upgrade_button', 'Upgrade')}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * Inline Change Plan picker. Drives the in-app plan-change endpoint — no new
 * Stripe Checkout session. The server provides changeable_plans (both
 * directions, same scope + interval). Selecting one opens a confirmation
 * modal with the prorated cost preview.
 */
export function ChangePlanPicker({ plans, pickerRef, ...state }: PickerState & { plans: BillingPlan[]; pickerRef: Ref<HTMLDivElement> }) {
    const { t } = useLicenseText();
    return (
        <div ref={pickerRef} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-3">
            <div className="flex items-center gap-2 mb-1">
                <Zap className="w-4 h-4 text-[var(--accent-primary)]" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('org.change_plan', 'Change plan')}</h3>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                {t('org.change_plan_hint', 'Upgrades take effect immediately (prorated). Downgrades take effect at the end of your current billing period.')}
            </p>
            <div className="grid gap-3">
                {plans.map(plan => <ChangePlanCard key={plan.id} plan={plan} {...state} />)}
            </div>
        </div>
    );
}

interface PlanSummaryCardProps {
    sub: OrgSubscription;
    limits: PlanLimits;
    canChangePlan: boolean;
    billing: Pick<OrgSubscriptionState, 'showChangePlan' | 'setShowChangePlan' | 'handleManageBilling' | 'portalLoading'>;
}

const OUTLINE_BUTTON = buttonClass('secondary', 'sm');

/** The plan the org is on: name, status, cycle start, the plan actions and the cost cap. */
export function PlanSummaryCard({ sub, limits, canChangePlan, billing }: PlanSummaryCardProps) {
    const { t, fmtDate } = useLicenseText();
    const { showChangePlan, setShowChangePlan, handleManageBilling, portalLoading } = billing;
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
            <div className="p-5 flex flex-wrap items-center justify-between gap-3 bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-[var(--bg-tertiary)]">
                        <Zap className="w-6 h-6 text-[var(--text-primary)]" aria-hidden="true" />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-base font-semibold text-[var(--text-primary)]">{sub.plan_name || t('org.custom_plan', 'Custom')}</h3>
                            <span className={statusChip(sub.status)}>
                                {sub.status === 'manual_action_required' ? t('org.sub_status_manual_action_required', 'Payment action required') : sub.status}
                            </span>
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">
                            {t('org.billing_started', 'Billing cycle started {date}', { date: sub.billing_cycle_start ? fmtDate(sub.billing_cycle_start) : '—' })}
                        </p>
                    </div>
                </div>
                {/* Change plan / Manage Billing actions. The toggle shows when the
                    sub is Stripe-managed, the server offers a changeable plan (up or
                    down), and we're not mid-cancellation. */}
                {canChangePlan && (
                    <button
                        type="button"
                        aria-expanded={showChangePlan}
                        onClick={() => setShowChangePlan(v => !v)}
                        className={OUTLINE_BUTTON}
                    >
                        <Zap className="w-3 h-3" />
                        {showChangePlan
                            ? t('org.change_plan_close', 'Close')
                            : t('org.change_plan', 'Change plan')}
                    </button>
                )}
                {/* BFSF-241: only show the Stripe Customer Portal link for a real
                    paying relationship. Free/trial/no-invoice customers got an
                    empty "no invoice history" portal showing global payment
                    methods (Pix/Kakao/Amazon) that don't match our checkout.
                    Shared predicate (utils/billing.js) mirrors the server gate. */}
                {hasPaidBillingRelationship(sub) && (
                    <button
                        onClick={handleManageBilling}
                        disabled={portalLoading}
                        className={OUTLINE_BUTTON}
                    >
                        {portalLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
                        {t('org.manage_billing', 'Manage Billing')}
                    </button>
                )}
                {limits.max_cost_per_month != null && limits.max_cost_per_month !== -1 && (
                    <div className="text-right">
                        <div className="text-xl font-bold text-[var(--text-primary)]">€{Number(limits.max_cost_per_month).toFixed(2)}</div>
                        <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">{t('org.cost_cap_month')}</div>
                    </div>
                )}
            </div>
            {/* AI usage is read out once, in "Usage this period" below
                (as % of the cost cap, with the warning colours). */}
        </div>
    );
}
