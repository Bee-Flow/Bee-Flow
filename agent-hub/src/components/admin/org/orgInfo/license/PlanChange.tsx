import { ArrowRight, ExternalLink, Loader2, Zap } from 'lucide-react';
import type { Ref } from 'react';
import { intervalLabel, planCurrencySymbol, useLicenseText } from './licenseShared';
import type { BillingPlan, OrgSubscription, PlanLimits } from './licenseShared';
import { PlanCaps } from './PlanOffers';
import type { OrgSubscriptionState } from './useOrgSubscription';
import { hasPaidBillingRelationship } from '@/utils/billing';

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
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider ${isDown ? 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]' : 'bg-blue-500/15 text-blue-500'}`}>
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
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50"
                        style={{ background: isDown ? '#64748b' : '#3b82f6' }}
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
                <Zap className="w-4 h-4 [color:#3b82f6]" />
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

const OUTLINE_BUTTON = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all hover:opacity-80';

/** The plan the org is on: name, status, cycle start, the plan actions and the cost cap. */
export function PlanSummaryCard({ sub, limits, canChangePlan, billing }: PlanSummaryCardProps) {
    const { t, fmtDate } = useLicenseText();
    const { showChangePlan, setShowChangePlan, handleManageBilling, portalLoading } = billing;
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
            <div className="p-5 flex items-center justify-between [background:rgba(59,130,246,0.06)]">
                <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center [background:#3b82f6]">
                        <Zap className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-lg font-bold text-[var(--text-primary)]">{sub.plan_name || t('org.custom_plan', 'Custom')}</h3>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${sub.status === 'active' ? 'bg-green-500/15 text-green-500'
                                : sub.status === 'suspended' ? 'bg-red-500/15 text-red-500'
                                    : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                                }`}>
                                {sub.status}
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
                        style={{ borderColor: 'rgba(59,130,246,0.3)', color: '#3b82f6', background: 'rgba(59,130,246,0.05)' }}
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
                        style={{ borderColor: 'rgba(59,130,246,0.3)', color: '#3b82f6', background: 'rgba(59,130,246,0.05)' }}
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
