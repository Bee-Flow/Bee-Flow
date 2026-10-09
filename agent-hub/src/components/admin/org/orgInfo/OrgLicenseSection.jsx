import { AlertTriangle, CreditCard, BarChart3, Zap, DollarSign, Users, Bot, Database, Shield, Info, Plus, ExternalLink, Loader2, ArrowRight, Sparkles, Clock } from 'lucide-react';
import { useId } from 'react';
import { currencySym, UsageBar } from './orgInfoShared';
import { hasPaidBillingRelationship } from '../../../../utils/billing';
import { cloudFetch } from '../../../../utils/cloudFetch';
import { API_BASE } from '../../../../utils/helpers';
import InvoicesPanel from '../../../billing/InvoicesPanel';
import LicenseKeyActivation from '../../../licensing/LicenseKeyActivation';
import Modal from '../../../shared/Modal';

// ── License & Usage section — extracted verbatim from OrgInfoPanel. All state
// stays on the parent fiber; everything arrives via props.
const OrgLicenseSection = ({
    t,
    licenseCtx,
    hasActiveLicenseKey,
    showLicenseActivation,
    isCloud,
    deploymentMode,
    orgData,
    setOrgData,
    subscription,
    subLoading,
    subMessage,
    setSubMessage,
    checkoutSettling,
    availablePlans,
    checkoutLoading,
    handleCheckout,
    portalLoading,
    handleManageBilling,
    showChangePlan,
    setShowChangePlan,
    handleSelectChange,
    previewLoading,
    changeTarget,
    setChangeTarget,
    changePreview,
    setChangePreview,
    changeBusy,
    handleConfirmChange,
    cancelBusy,
    handleCancelDowngrade,
    handleReactivateSubscription,
    handleCancelSubscription,
    doCancelSubscription,
    showCancelConfirm,
    setShowCancelConfirm,
    goToUsersPanel,
}) => {
    // Extract subscription info
    const sub = subscription;
    const limits = sub?.effective_limits || {};
    const usage = sub?.current_usage || {};

    // Member-facing org view always shows marked-up cost — message/token
    // counts are deliberately hidden. The upgrade CTA fires when AI usage
    // cost approaches the plan's cost cap (if one is set).
    const orgCostPct = (limits.max_cost_per_month && limits.max_cost_per_month !== -1)
        ? Math.min(100, Math.round(((usage.cost || 0) / limits.max_cost_per_month) * 100))
        : 0;
    const showOrgUpgradeCta = orgCostPct >= 80;
    // The two confirmations below are labelled by their headings.
    const dialogIds = useId();

    return (
                    <div className="max-w-xl mx-auto space-y-6 animate-fadeIn">
                        <div>
                            {/* Heading reflects whether this org is on a real paid subscription:
                                "Subscription & Usage" when it is, "License & Usage" otherwise. */}
                            <h2 className="text-lg font-bold text-[var(--text-primary)]">
                                {(sub?.stripe_subscription_id || (sub?.billing?.subscription_total || 0) > 0)
                                    ? t('org.subscription_usage', 'Subscription & Usage')
                                    : t('org.license_usage')}
                            </h2>
                            <p className="text-sm text-[var(--text-muted)] mt-0.5">{t('org.license_subtitle')}</p>
                        </div>

                        {/* Subscription action result (upgrade/downgrade/cancel/checkout) —
                            rendered inline here, never in the org-info save bar. */}
                        {subMessage && (
                            <div className={`rounded-xl px-4 py-2.5 text-[12.5px] font-medium flex items-center gap-2 ${subMessage.type === 'success' ? 'bg-green-500/10 text-green-600 border border-green-500/30' : 'bg-red-500/10 text-red-500 border border-red-500/30'}`}>
                                <span>{subMessage.type === 'success' ? '✓' : '⚠'}</span>
                                <span className="flex-1">{subMessage.text}</span>
                                <button onClick={() => setSubMessage(null)} className="opacity-60 hover:opacity-100">✕</button>
                            </div>
                        )}

                        {/* License key activation (self-hosted; or cloud Full-tier internal orgs) */}
                        {showLicenseActivation && <LicenseKeyActivation />}

                        {/* Server-wide licence in effect: the whole install runs at the
                            licence tier, so this org needs no Stripe subscription. Hide the
                            cloud subscription/usage/plans dashboard entirely and show a
                            read-only note instead. Suppressed when LicenseKeyActivation is
                            already rendering its own server-override banner (self-hosted). */}
                        {licenseCtx?.serverOverride && !showLicenseActivation && (
                            <div className="rounded-2xl border px-5 py-4 flex items-start gap-3"
                                style={{ borderColor: 'rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.06)' }}>
                                <Shield className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'rgb(59,130,246)' }} />
                                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    <div className="font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
                                        {t('license.server_override_title', 'Tier is managed server-wide')}
                                    </div>
                                    <div>
                                        {t('org.server_license_no_subscription',
                                           'This installation is covered by a server-wide licence, so your organisation does not need a subscription. Usage and billing are managed by the platform operator.')}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Post-checkout settling spinner. Drives the polling loop that waits
                            for the Stripe webhook to flip status → active/trialing. */}
                        {!licenseCtx?.serverOverride && checkoutSettling && (
                            <div
                                className="rounded-2xl border px-4 py-3 flex items-center gap-3"
                                style={{ borderColor: 'rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.06)' }}
                            >
                                <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: '#3b82f6' }} />
                                <div className="flex-1 min-w-0">
                                    <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                                        {t('org.activating_subscription', 'Activating your subscription…')}
                                    </p>
                                    <p className="text-[11.5px] text-[var(--text-muted)]">
                                        {t('org.activating_subscription_hint', 'Payment received — confirming with Stripe.')}
                                    </p>
                                </div>
                            </div>
                        )}

                        {!licenseCtx?.serverOverride && (subLoading ? (
                            <div className="space-y-4 animate-pulse">
                                <div className="h-28 rounded-2xl bg-[var(--bg-tertiary)]" />
                                <div className="h-40 rounded-2xl bg-[var(--bg-tertiary)]" />
                            </div>
                        ) : !sub && hasActiveLicenseKey ? (
                            // License-key activation already shown above; the legacy
                            // Stripe "No subscription" placeholder would just confuse
                            // self-hosted users who paid via license key.
                            null
                        ) : !sub ? (
                            <div className="space-y-5">
                                <div className="p-6 rounded-2xl border-2 border-dashed border-[var(--border-subtle)] text-center">
                                    <CreditCard className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)] opacity-40" />
                                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('org.no_license')}</p>
                                    <p className="text-xs text-[var(--text-muted)] mt-1">{t('org.no_license_desc')}</p>
                                </div>

                                {/* Available plans from Stripe — cloud only; self-hosted uses license keys */}
                                {isCloud && availablePlans.length > 0 ? (
                                    <div>
                                        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                                            <Zap className="w-4 h-4" style={{ color: '#3b82f6' }} />
                                            {t('org.choose_plan', 'Choose a Plan')}
                                        </h3>
                                        <div className="grid gap-3">
                                            {availablePlans.map(plan => {
                                                const currencySymbol = (plan.currency || 'eur').toUpperCase() === 'EUR' ? '€' : (plan.currency || 'eur').toUpperCase() === 'GBP' ? '£' : '$';
                                                return (
                                                    <div key={plan.id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 hover:border-[var(--accent-primary)] transition-colors">
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2 mb-1">
                                                                    <h4 className="text-sm font-bold text-[var(--text-primary)]">{plan.name}</h4>
                                                                    {plan.trial_days > 0 && (
                                                                        <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-green-500/15 text-green-500">
                                                                            {t('admin_org.license_free_trial_days', '{days}d free trial', { days: plan.trial_days })}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                {plan.description && <p className="text-[11px] text-[var(--text-muted)] mb-2">{plan.description}</p>}
                                                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--text-muted)]">
                                                                    {plan.max_users && plan.max_users !== -1 && <span>{t('admin_org.license_max_users', '{n} users', { n: plan.max_users })}</span>}
                                                                    {plan.max_agents && plan.max_agents !== -1 && <span>{t('admin_org.license_max_agents', '{n} agents', { n: plan.max_agents })}</span>}
                                                                    {plan.max_knowledge_sources && plan.max_knowledge_sources !== -1 && <span>{t('admin_org.license_max_kb', '{n} KB sources', { n: plan.max_knowledge_sources })}</span>}
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-3 ml-4">
                                                                <div className="text-right">
                                                                    <div className="text-lg font-bold text-[var(--text-primary)]">{currencySymbol}{plan.price.toFixed(2)}</div>
                                                                    <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider">/ {plan.billing_interval || 'month'}</div>
                                                                </div>
                                                                <button
                                                                    onClick={() => handleCheckout(plan.id)}
                                                                    disabled={checkoutLoading === plan.id || !plan.has_stripe_price}
                                                                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50"
                                                                    style={{ background: '#3b82f6' }}
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
                                            })}
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
                        ) : (
                            <>
                                {/* Plan Card */}
                                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
                                    <div className="p-5 flex items-center justify-between" style={{ background: 'rgba(59, 130, 246, 0.06)' }}>
                                        <div className="flex items-center gap-4">
                                            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: '#3b82f6' }}>
                                                <Zap className="w-6 h-6 text-white" />
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <h3 className="text-lg font-bold text-[var(--text-primary)]">{sub.plan_name || 'Custom'}</h3>
                                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${sub.status === 'active' ? 'bg-green-500/15 text-green-500'
                                                        : sub.status === 'suspended' ? 'bg-red-500/15 text-red-500'
                                                            : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                                                        }`}>
                                                        {sub.status}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                                    {t('org.billing_started').replace('{date}', sub.billing_cycle_start ? new Date(sub.billing_cycle_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'N/A')}
                                                </p>
                                            </div>
                                        </div>
                                        {/* Change plan / Manage Billing actions. The toggle shows when the
                                            sub is Stripe-managed, the server offers a changeable plan (up or
                                            down), and we're not mid-cancellation. */}
                                        {isCloud && sub.stripe_subscription_id && Array.isArray(sub.changeable_plans) && sub.changeable_plans.length > 0 && !sub.cancel_at_period_end && !sub.pending_plan_id && (
                                            <button
                                                onClick={() => setShowChangePlan(v => !v)}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all hover:opacity-80"
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
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all hover:opacity-80"
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

                                    {/* Quick stats — AI usage shown as % of the cost cap (the actual
                                        € amount is intentionally hidden for fixed-plan customers; the
                                        cap itself and the subscription price remain in € below). */}
                                    <div className="border-t border-[var(--border-subtle)]">
                                        <div className="p-4 text-center">
                                            <div className="text-2xl font-bold text-[var(--text-primary)]">
                                                {(limits.max_cost_per_month && limits.max_cost_per_month !== -1) ? `${orgCostPct}%` : '—'}
                                            </div>
                                            <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mt-0.5">
                                                {(limits.max_cost_per_month && limits.max_cost_per_month !== -1)
                                                    ? t('org.ai_usage_of_cap', 'AI usage of cap this period')
                                                    : t('org.ai_usage_this_period', 'AI usage this period')}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Invoices — in-app list with Stripe PDF downloads */}
                                {sub.stripe_customer_id && (
                                    <InvoicesPanel
                                        fetcher={async () => {
                                            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/stripe/invoices`);
                                            if (!res.ok) throw new Error('Failed to load invoices');
                                            const data = await res.json();
                                            return data.invoices || [];
                                        }}
                                        pdfFetcher={(invoiceId) => cloudFetch(deploymentMode, `${API_BASE}/api/stripe/invoices/${invoiceId}/pdf`)}
                                    />
                                )}

                                {/* Inline Change Plan picker. Drives the in-app plan-change endpoint
                                    — no new Stripe Checkout session. Server provides changeable_plans
                                    (both directions, same scope + interval). Selecting one opens a
                                    confirmation modal with the prorated cost preview. */}
                                {showChangePlan && isCloud && sub.stripe_subscription_id && Array.isArray(sub.changeable_plans) && sub.changeable_plans.length > 0 && !sub.cancel_at_period_end && !sub.pending_plan_id && (
                                    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-3">
                                        <div className="flex items-center gap-2 mb-1">
                                            <Zap className="w-4 h-4" style={{ color: '#3b82f6' }} />
                                            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('org.change_plan', 'Change plan')}</h3>
                                        </div>
                                        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                                            {t('org.change_plan_hint', 'Upgrades take effect immediately (prorated). Downgrades take effect at the end of your current billing period.')}
                                        </p>
                                        <div className="grid gap-3">
                                            {sub.changeable_plans.map(plan => {
                                                const sym = (plan.currency || 'eur').toUpperCase() === 'EUR' ? '€' : (plan.currency || 'eur').toUpperCase() === 'GBP' ? '£' : '$';
                                                const isDown = plan.direction === 'downgrade';
                                                return (
                                                    <div key={plan.id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 hover:border-[var(--accent-primary)] transition-colors">
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2 mb-1">
                                                                    <h4 className="text-sm font-bold text-[var(--text-primary)]">{plan.name}</h4>
                                                                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider ${isDown ? 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]' : 'bg-blue-500/15 text-blue-500'}`}>
                                                                        {isDown ? t('org.downgrade', 'Downgrade') : t('org.upgrade', 'Upgrade')}
                                                                    </span>
                                                                </div>
                                                                {plan.description && <p className="text-[11px] text-[var(--text-muted)] mb-2">{plan.description}</p>}
                                                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--text-muted)]">
                                                                    {plan.max_users && plan.max_users !== -1 && <span>{t('admin_org.license_max_users', '{n} users', { n: plan.max_users })}</span>}
                                                                    {plan.max_agents && plan.max_agents !== -1 && <span>{t('admin_org.license_max_agents', '{n} agents', { n: plan.max_agents })}</span>}
                                                                    {plan.max_knowledge_sources && plan.max_knowledge_sources !== -1 && <span>{t('admin_org.license_max_kb', '{n} KB sources', { n: plan.max_knowledge_sources })}</span>}
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-3 ml-4">
                                                                <div className="text-right">
                                                                    <div className="text-lg font-bold text-[var(--text-primary)]">{sym}{Number(plan.price).toFixed(2)}</div>
                                                                    <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider">/ {plan.billing_interval || 'month'}</div>
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
                                            })}
                                        </div>
                                    </div>
                                )}

                                {/* Scheduled-downgrade banner. The org keeps its current (higher) plan
                                    until pending_plan_effective, then the schedule flips it down.
                                    The Undo button releases the Stripe schedule. */}
                                {sub.pending_plan_id && (
                                    <div
                                        className="rounded-2xl border px-4 py-3 flex items-center gap-3"
                                        style={{ borderColor: 'rgba(100,116,139,0.35)', background: 'rgba(100,116,139,0.06)' }}
                                    >
                                        <Clock className="w-4 h-4 shrink-0" style={{ color: '#64748b' }} />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                                                {t('org.downgrade_scheduled', 'Downgrade to')} {sub.pending_plan_name || t('org.a_lower_plan', 'a lower plan')} {t('org.downgrade_scheduled_on', 'on')} {sub.pending_plan_effective ? new Date(sub.pending_plan_effective).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : t('org.period_end', 'the end of this period')}.
                                            </p>
                                            <p className="text-[11.5px] text-[var(--text-muted)]">
                                                {t('org.downgrade_keeps_access', 'You keep your current plan until then.')}
                                            </p>
                                        </div>
                                        <button
                                            onClick={handleCancelDowngrade}
                                            disabled={cancelBusy}
                                            className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-all hover:opacity-80 disabled:opacity-50"
                                            style={{ borderColor: 'rgba(100,116,139,0.35)', color: '#64748b', background: 'rgba(100,116,139,0.05)' }}
                                        >
                                            {cancelBusy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : t('org.keep_current_plan', 'Keep current plan')}
                                        </button>
                                    </div>
                                )}

                                {/* Highest-plan message: only when there's a paying sub and the
                                    server has no changeable plans (and we're not mid-cancel/pending). */}
                                {isCloud && sub.stripe_subscription_id && (sub.billing?.subscription_total || 0) > 0 && Array.isArray(sub.changeable_plans) && sub.changeable_plans.length === 0 && !sub.cancel_at_period_end && !sub.pending_plan_id && (
                                    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 text-[12px] text-[var(--text-muted)]">
                                        {t('org.on_highest_plan', "You're on the highest plan — contact")} <a href="mailto:info@beeflow.nl" className="text-[#3b82f6] hover:underline">info@beeflow.nl</a> {t('org.for_custom_pricing', 'for custom pricing.')}
                                    </div>
                                )}

                                {/* Subscribe-to-paid section for orgs on a free/manual (non-Stripe)
                                    plan. Routes through Stripe Checkout, which establishes the
                                    stripe_subscription_id so upgrades/downgrades/billing work after. */}
                                {isCloud && !sub.stripe_subscription_id && availablePlans.length > 0 && (
                                    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-3">
                                        <div className="flex items-center gap-2 mb-1">
                                            <Zap className="w-4 h-4" style={{ color: '#3b82f6' }} />
                                            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('org.upgrade_to_paid', 'Upgrade to a paid plan')}</h3>
                                        </div>
                                        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                                            {t('org.upgrade_to_paid_hint', "You're on a free plan. Subscribe to unlock higher usage and more features — you'll be taken to secure Stripe checkout.")}
                                        </p>
                                        {/* BFSF-243: recurring-billing (automatische incasso) disclosure */}
                                        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                                            <CreditCard className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                                            <p className="text-[11px] leading-snug text-[var(--text-secondary)]">
                                                {t('billing.recurring_notice', 'This is a recurring subscription. Your selected payment method is charged automatically at the start of each billing period (automatische incasso) until you cancel.')}
                                            </p>
                                        </div>
                                        <div className="grid gap-3">
                                            {availablePlans.map(plan => {
                                                const sym = (plan.currency || 'eur').toUpperCase() === 'EUR' ? '€' : (plan.currency || 'eur').toUpperCase() === 'GBP' ? '£' : '$';
                                                return (
                                                    <div key={plan.id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 hover:border-[var(--accent-primary)] transition-colors">
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2 mb-1">
                                                                    <h4 className="text-sm font-bold text-[var(--text-primary)]">{plan.name}</h4>
                                                                    {plan.trial_days > 0 && (
                                                                        <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-green-500/15 text-green-500">{t('admin_org.license_free_trial_days', '{days}d free trial', { days: plan.trial_days })}</span>
                                                                    )}
                                                                </div>
                                                                {plan.description && <p className="text-[11px] text-[var(--text-muted)] mb-2">{plan.description}</p>}
                                                            </div>
                                                            <div className="flex items-center gap-3 ml-4">
                                                                <div className="text-right">
                                                                    <div className="text-lg font-bold text-[var(--text-primary)]">{sym}{Number(plan.price).toFixed(2)}</div>
                                                                    <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider">/ {plan.billing_interval || 'month'}{plan.per_seat ? ` ${t('org.per_seat', '/ seat')}` : ''}</div>
                                                                </div>
                                                                <div className="flex flex-col items-end gap-1">
                                                                    <button
                                                                        onClick={() => handleCheckout(plan.id)}
                                                                        disabled={checkoutLoading === plan.id}
                                                                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50"
                                                                        style={{ background: '#3b82f6' }}
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
                                            })}
                                        </div>
                                    </div>
                                )}

                                {/* Scheduled-cancel banner. Shown when Stripe (or this user) has set
                                    cancel_at_period_end=true. The org keeps access until cancel_at;
                                    the Reactivate button calls /reactivate to clear the flag. */}
                                {sub.cancel_at_period_end && (
                                    <div
                                        className="rounded-2xl border px-4 py-3 flex items-center gap-3"
                                        style={{ borderColor: 'rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.06)' }}
                                    >
                                        <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: '#3b82f6' }} />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                                                {t('org.cancel_scheduled', 'Subscription cancels on')} {sub.cancel_at ? new Date(sub.cancel_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : 'the end of this period'}.
                                            </p>
                                            <p className="text-[11.5px] text-[var(--text-muted)]">
                                                {t('org.cancel_keeps_access', 'You keep access until that date.')}
                                            </p>
                                        </div>
                                        <button
                                            onClick={handleReactivateSubscription}
                                            disabled={cancelBusy}
                                            className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-all hover:opacity-80 disabled:opacity-50"
                                            style={{ borderColor: 'rgba(59,130,246,0.3)', color: '#3b82f6', background: 'rgba(59,130,246,0.05)' }}
                                        >
                                            {cancelBusy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : t('org.keep_subscription', 'Keep subscription')}
                                        </button>
                                    </div>
                                )}

                                {/* Subscription billing card */}
                                {sub.billing && Number(sub.billing.subscription_total) > 0 && (
                                    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5">
                                        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                                            <CreditCard className="w-4 h-4 text-[var(--text-muted)]" />
                                            {t('org.subscription', 'Subscription')}
                                        </h3>
                                        <div className="flex items-baseline justify-between">
                                            <span className="text-[12px] text-[var(--text-muted)]">{t('org.billed_per_cycle', 'Billed per cycle')}</span>
                                            <span className="text-2xl font-bold text-[var(--text-primary)]">
                                                {currencySym(sub.billing.plan_currency)}{Number(sub.billing.subscription_total).toFixed(2)}
                                                <span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">/ {sub.billing.billing_interval === 'yearly' ? t('org.year', 'year') : t('org.month', 'month')}</span>
                                            </span>
                                        </div>
                                        {sub.billing.per_seat && (
                                            <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                                                <div className="flex items-center justify-between text-[12px]">
                                                    <span className="text-[var(--text-muted)]">
                                                        {sub.billing.seat_quantity} × {currencySym(sub.billing.plan_currency)}{Number(sub.billing.plan_price).toFixed(2)} {t('org.per_seat', '/ seat')}
                                                    </span>
                                                    <span className="flex items-center gap-2">
                                                        <span className="text-[var(--text-secondary)] font-medium">
                                                            {sub.billing.seat_quantity} {sub.billing.seat_quantity === 1 ? t('org.seat', 'seat') : t('org.seats', 'seats')}
                                                        </span>
                                                        {/* BFSF-251: the Add-user CTA must exist on EVERY
                                                            per-seat sub — the plan-limits card below filters
                                                            out unlimited (-1/null) tiles, so per-seat plans
                                                            without a finite max_users lost the CTA entirely. */}
                                                        <button
                                                            type="button"
                                                            onClick={goToUsersPanel}
                                                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border transition-all hover:opacity-80"
                                                            style={{ borderColor: 'rgba(59,130,246,0.3)', color: '#3b82f6', background: 'rgba(59,130,246,0.05)' }}
                                                        >
                                                            <Plus className="w-3 h-3" /> {t('org.add_user', 'Add user')}
                                                        </button>
                                                    </span>
                                                </div>
                                                <div className="mt-2 flex items-start gap-2 text-[11px] text-[var(--text-muted)]">
                                                    <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                                    <span>{t('org.add_user_hint', 'Inviting a user adds a seat to your plan. Extra seats are billed per user per month and prorated for the current period.')} {t('org.seats_proration_note', 'Stripe prorates the difference on your next invoice.')}</span>
                                                </div>
                                            </div>
                                        )}
                                        {/* Cancel-at-period-end action. Muted — destructive but reversible
                                            (the Reactivate banner appears on success). Hidden during the
                                            scheduled-cancel window since the banner has its own undo CTA. */}
                                        {sub.stripe_subscription_id && sub.status === 'active' && !sub.cancel_at_period_end && (
                                            <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] flex justify-end">
                                                <button
                                                    onClick={handleCancelSubscription}
                                                    disabled={cancelBusy}
                                                    className="text-[11.5px] font-medium text-[#64748b] hover:text-[var(--text-primary)] disabled:opacity-50 transition-colors"
                                                >
                                                    {cancelBusy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : t('org.cancel_subscription', 'Cancel subscription')}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Upgrade CTA — surfaces when AI usage cost approaches the plan cap */}
                                {showOrgUpgradeCta && (
                                    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-center gap-3">
                                        <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                                                {t('admin_org.license_budget_used', "You've used {pct}% of your AI usage budget this period.", { pct: orgCostPct })}
                                            </p>
                                            <p className="text-[11.5px] text-[var(--text-muted)]">{t('admin_org.license_upgrade_hint', 'Upgrade to a higher plan for more AI usage.')}</p>
                                        </div>
                                        <a
                                            href="/app/admin/subscriptions"
                                            className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                                        >
                                            {t('admin_org.license_upgrade_plan', 'Upgrade plan')}
                                        </a>
                                    </div>
                                )}

                                {/* Usage Bars — AI usage shown as % of cap only (no € amount). */}
                                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-4">
                                    <div className="flex items-center gap-2 mb-1">
                                        <BarChart3 className="w-4 h-4 text-[var(--text-muted)]" />
                                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('org.usage_this_period')}</h3>
                                    </div>

                                    <UsageBar
                                        label={t('org.ai_usage', 'AI usage')}
                                        icon={DollarSign}
                                        used={usage.cost || 0}
                                        limit={limits.max_cost_per_month}
                                        color="#10b981"
                                        percentOnly
                                    />
                                </div>

                                {/* Plan limits grid — only renders concrete caps; ∞ tiles are hidden,
                                    and the whole card collapses when no limits are set and there are no notes. */}
                                {(() => {
                                    const limitItems = [
                                        { key: 'users', label: t('org.users'), icon: Users, val: limits.max_users, color: '#3b82f6' },
                                        { key: 'agents', label: t('org.agents'), icon: Bot, val: limits.max_agents, color: '#f59e0b' },
                                        { key: 'knowledge', label: t('org.knowledge_sources'), icon: Database, val: limits.max_knowledge_sources, color: '#10b981' },
                                    ].filter(it => it.val !== null && it.val !== undefined && it.val !== -1);
                                    if (limitItems.length === 0 && !sub.notes) return null;
                                    return (
                                        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5">
                                            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">{t('org.plan_limits')}</h3>
                                            {limitItems.length > 0 && (
                                                <div className="grid grid-cols-2 gap-3">
                                                    {limitItems.map(item => {
                                                        const Icon = item.icon;
                                                        return (
                                                            <div key={item.label} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
                                                                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${item.color}10` }}>
                                                                    <Icon className="w-4 h-4" style={{ color: item.color }} />
                                                                </div>
                                                                <div>
                                                                    <div className="text-sm font-bold text-[var(--text-primary)]">
                                                                        {/* BFSF-251: on the Users tile show LIVE seats vs the
                                                                            plan limit, not the bare cap — "1 Gebruiker" told
                                                                            the reporter nothing about usage or headroom. */}
                                                                        {item.key === 'users' && sub.billing?.seat_quantity != null
                                                                            ? `${sub.billing.seat_quantity} / ${Number(item.val).toLocaleString()}`
                                                                            : Number(item.val).toLocaleString()}
                                                                    </div>
                                                                    <div className="text-[10px] text-[var(--text-muted)]">{item.label}</div>
                                                                </div>
                                                                {/* BFSF-251: direct seat/user add from the Gebruikers card */}
                                                                {item.key === 'users' && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={goToUsersPanel}
                                                                        className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border transition-all hover:opacity-80"
                                                                        style={{ borderColor: 'rgba(59,130,246,0.3)', color: '#3b82f6', background: 'rgba(59,130,246,0.05)' }}
                                                                    >
                                                                        <Plus className="w-3 h-3" /> {t('org.add_user', 'Add user')}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                            {/* BFSF-251: per-seat plans bill each invited user; surface how the
                                                proration works so adding a seat isn't a surprise on the invoice. */}
                                            {sub.billing?.per_seat && (
                                                <div className="mt-3 flex items-start gap-2 text-[11px] text-[var(--text-muted)]">
                                                    <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                                    <span>{t('org.add_user_hint', 'Inviting a user adds a seat to your plan. Extra seats are billed per user per month and prorated for the current period.')} {t('org.seats_proration_note', 'Stripe prorates the difference on your next invoice.')}</span>
                                                </div>
                                            )}
                                            {sub.notes && (
                                                <div className={limitItems.length > 0 ? 'mt-4 pt-4 border-t border-[var(--border-subtle)]' : ''}>
                                                    <p className="text-xs text-[var(--text-muted)]">
                                                        <span className="font-medium text-[var(--text-secondary)]">{t('org.notes')}: </span>
                                                        {sub.notes}
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })()}
                            </>
                        ))}

                        {/* ── AI usage sharing (moved here from Org Info) ──
                            Only shown when a subscription with a real cost
                            budget is bound to the org; the toggle merely splits
                            that budget, so it's meaningless (and hidden) on the
                            free Community / no-subscription tier. */}
                        {!licenseCtx?.serverOverride && orgData && subscription
                            && limits.max_cost_per_month != null && limits.max_cost_per_month !== -1 && (
                            <div className="space-y-3 pt-2">
                                <div>
                                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('org.share_usage', 'AI usage sharing')}</h3>
                                    <p className="text-[12px] text-[var(--text-muted)] mt-0.5">{t('org.share_usage_desc', 'Choose whether your team shares one AI-usage budget, or whether each user gets their own slice.')}</p>
                                </div>
                                <div className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-start gap-3">
                                    <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: 'rgba(16,185,129,0.12)' }}>
                                        <Users className="w-4 h-4" style={{ color: '#10b981' }} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('org.share_usage_label', 'Share AI usage across the organisation')}</p>
                                        <p className="text-[11px] text-[var(--text-muted)] mt-0.5 mb-3">{t('org.share_usage_explainer', 'When on, every user shares the plan\'s cost budget. When off, the budget is divided equally between active users so each user gets their own slice for the period.')}</p>
                                        <label className="inline-flex items-center gap-3 cursor-pointer select-none">
                                            <span className="relative inline-flex h-5 w-9 items-center">
                                                <input
                                                    type="checkbox"
                                                    checked={!!orgData.usagePooled}
                                                    onChange={e => setOrgData(p => ({ ...p, usagePooled: e.target.checked }))}
                                                    className="sr-only peer"
                                                />
                                                <span className="absolute inset-0 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-default)] peer-checked:bg-emerald-500 peer-checked:border-emerald-500 transition-colors" />
                                                <span className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
                                            </span>
                                            <span className="text-[12px] text-[var(--text-secondary)]">
                                                {orgData.usagePooled
                                                    ? t('org.share_usage_on', 'Pooled across the organisation')
                                                    : t('org.share_usage_off', 'Each user has their own budget')}
                                            </span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* ── Change-plan confirmation modal ── */}
                        {/* Through the shared Modal. Escape and the backdrop close
                            both confirmations, and neither does while its request
                            is in flight — the rule the backdrop already had. */}
                        {changeTarget && changePreview && (
                            <Modal
                                open
                                onClose={() => { if (!changeBusy) { setChangeTarget(null); setChangePreview(null); } }}
                                variant="bare"
                                size="md"
                                labelledBy={dialogIds + '-change'}
                            >
                                <div className="w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-4">
                                    <div className="flex items-center gap-2">
                                        <Zap className="w-4 h-4" style={{ color: changePreview.direction === 'downgrade' ? '#64748b' : '#3b82f6' }} />
                                        <h3 id={dialogIds + '-change'} className="text-sm font-bold text-[var(--text-primary)]">
                                            {changePreview.direction === 'downgrade' ? t('org.confirm_downgrade', 'Confirm downgrade') : t('org.confirm_upgrade', 'Confirm upgrade')} — {changeTarget.name}
                                        </h3>
                                    </div>
                                    {(() => {
                                        const sym = (changePreview.currency || 'EUR').toUpperCase() === 'EUR' ? '€' : (changePreview.currency || 'EUR').toUpperCase() === 'GBP' ? '£' : '$';
                                        const renewal = `${sym}${Number(changePreview.next_renewal_total || 0).toFixed(2)} / ${(changeTarget.billing_interval === 'yearly' ? t('org.year', 'year') : t('org.month', 'month'))}`;
                                        if (changePreview.direction === 'downgrade') {
                                            const date = changePreview.effective ? new Date(changePreview.effective).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : t('org.period_end', 'the end of this period');
                                            return (
                                                <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-4 space-y-2 text-[13px]">
                                                    <div className="flex justify-between"><span className="text-[var(--text-muted)]">{t('org.takes_effect', 'Takes effect')}</span><span className="font-semibold text-[var(--text-primary)]">{date}</span></div>
                                                    <div className="flex justify-between"><span className="text-[var(--text-muted)]">{t('org.charge_today', 'Charge today')}</span><span className="font-semibold text-[var(--text-primary)]">{sym}0.00</span></div>
                                                    <div className="flex justify-between"><span className="text-[var(--text-muted)]">{t('org.then', 'Then')}</span><span className="font-semibold text-[var(--text-primary)]">{renewal}</span></div>
                                                </div>
                                            );
                                        }
                                        const charge = Number(changePreview.proration_amount || 0);
                                        return (
                                            <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-4 space-y-2 text-[13px]">
                                                <div className="flex justify-between"><span className="text-[var(--text-muted)]">{t('org.prorated_charge_today', 'Prorated charge today')}</span><span className="font-semibold text-[var(--text-primary)]">{sym}{charge.toFixed(2)}</span></div>
                                                <div className="flex justify-between"><span className="text-[var(--text-muted)]">{t('org.then', 'Then')}</span><span className="font-semibold text-[var(--text-primary)]">{renewal}</span></div>
                                                {changePreview.per_seat && changePreview.seat_quantity > 0 && (
                                                    <div className="flex justify-between text-[11px] pt-1 border-t border-[var(--border-subtle)]"><span className="text-[var(--text-muted)]">{changePreview.seat_quantity} {t('org.seats', 'seats')}</span><span className="text-[var(--text-muted)]">{t('org.billed_per_seat', 'billed per seat')}</span></div>
                                                )}
                                            </div>
                                        );
                                    })()}
                                    <div className="flex justify-end gap-2">
                                        <button onClick={() => { setChangeTarget(null); setChangePreview(null); }} disabled={changeBusy} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50">
                                            {t('org.cancel', 'Cancel')}
                                        </button>
                                        <button onClick={handleConfirmChange} disabled={changeBusy} className="px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white disabled:opacity-50" style={{ background: changePreview.direction === 'downgrade' ? '#64748b' : '#3b82f6' }}>
                                            {changeBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : t('org.confirm', 'Confirm')}
                                        </button>
                                    </div>
                                </div>
                            </Modal>
                        )}

                        {/* ── Cancel-subscription confirmation modal (in-app, not window.confirm) ── */}
                        {showCancelConfirm && (
                            <Modal
                                open
                                onClose={() => { if (!cancelBusy) setShowCancelConfirm(false); }}
                                variant="bare"
                                size="md"
                                labelledBy={dialogIds + '-cancel'}
                            >
                                <div className="w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-4">
                                    <div className="flex items-center gap-2">
                                        <AlertTriangle className="w-4 h-4 text-amber-500" />
                                        <h3 id={dialogIds + '-cancel'} className="text-sm font-bold text-[var(--text-primary)]">{t('org.cancel_subscription', 'Cancel subscription')}</h3>
                                    </div>
                                    <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed">
                                        {t('org.cancel_confirm_body', 'Cancel your subscription at the end of the current billing period? You keep full access until then, and no further payments will be taken.')}
                                    </p>
                                    <div className="flex justify-end gap-2">
                                        <button onClick={() => setShowCancelConfirm(false)} disabled={cancelBusy} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50">
                                            {t('org.keep_subscription', 'Keep subscription')}
                                        </button>
                                        <button onClick={doCancelSubscription} disabled={cancelBusy} className="px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-50">
                                            {cancelBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : t('org.cancel_subscription_confirm', 'Cancel subscription')}
                                        </button>
                                    </div>
                                </div>
                            </Modal>
                        )}
                    </div>
    );
};

export default OrgLicenseSection;
