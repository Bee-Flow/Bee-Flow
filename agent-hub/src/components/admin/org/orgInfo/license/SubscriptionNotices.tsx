import { AlertTriangle, Clock, Loader2, Shield, Sparkles } from 'lucide-react';
import { useLicenseText } from './licenseShared';
import type { OrgSubscription, SubMessage } from './licenseShared';

/**
 * Subscription action result (upgrade/downgrade/cancel/checkout, and the
 * Stripe checkout return) — rendered inline, never in the org-info save bar,
 * and kept until dismissed.
 */
export function SubMessageBanner({ message, onDismiss }: { message: SubMessage; onDismiss: () => void }) {
    const { t } = useLicenseText();
    return (
        <div
            role={message.type === 'success' ? 'status' : 'alert'}
            className={`rounded-xl px-4 py-2.5 text-[12.5px] font-medium flex items-center gap-2 ${message.type === 'success' ? 'bg-green-500/10 text-[var(--success-ink)] border border-green-500/30' : 'bg-red-500/10 text-[var(--error-ink)] border border-red-500/30'}`}
        >
            <span aria-hidden="true">{message.type === 'success' ? '✓' : '⚠'}</span>
            <span className="flex-1">{message.text}</span>
            <button type="button" onClick={onDismiss} aria-label={t('common.dismiss', 'Dismiss')} className="opacity-60 hover:opacity-100">✕</button>
        </div>
    );
}

/**
 * Server-wide licence in effect: the whole install runs at the licence tier,
 * so this org needs no Stripe subscription. The cloud subscription dashboard
 * is hidden and this read-only note shows instead.
 */
export function ServerOverrideNotice() {
    const { t } = useLicenseText();
    return (
        <div className="rounded-2xl border px-5 py-4 flex items-start gap-3 [border-color:rgba(59,130,246,0.3)] [background:rgba(59,130,246,0.06)]">
            <Shield className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'rgb(59,130,246)' }} />
            <div className="text-xs text-[var(--text-secondary)]">
                <div className="font-semibold mb-0.5 text-[var(--text-primary)]">
                    {t('license.server_override_title', 'Tier is managed server-wide')}
                </div>
                <div>
                    {t('org.server_license_no_subscription',
                       'This installation is covered by a server-wide licence, so your organisation does not need a subscription. Usage and billing are managed by the platform operator.')}
                </div>
            </div>
        </div>
    );
}

/** Post-checkout settling spinner, while the polling loop waits for the subscription to activate. */
export function CheckoutSettlingNotice() {
    const { t } = useLicenseText();
    return (
        <div
            className="rounded-2xl border px-4 py-3 flex items-center gap-3 [border-color:rgba(59,130,246,0.3)] [background:rgba(59,130,246,0.06)]"
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
    );
}

interface UndoBannerProps {
    sub: OrgSubscription;
    busy: boolean;
    onUndo: () => void;
}

/**
 * Scheduled-downgrade banner. The org keeps its current (higher) plan until
 * pending_plan_effective, then the schedule flips it down. Undo releases the
 * Stripe schedule.
 */
export function ScheduledDowngradeBanner({ sub, busy, onUndo }: UndoBannerProps) {
    const { t, fmtDate } = useLicenseText();
    return (
        <div
            className="rounded-2xl border px-4 py-3 flex items-center gap-3 [border-color:rgba(100,116,139,0.35)] [background:rgba(100,116,139,0.06)]"
        >
            <Clock className="w-4 h-4 shrink-0" style={{ color: '#64748b' }} />
            <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('org.downgrade_scheduled', 'Downgrade to')} {sub.pending_plan_name || t('org.a_lower_plan', 'a lower plan')} {t('org.downgrade_scheduled_on', 'on')} {sub.pending_plan_effective ? fmtDate(sub.pending_plan_effective) : t('org.period_end', 'the end of this period')}.
                </p>
                <p className="text-[11.5px] text-[var(--text-muted)]">
                    {t('org.downgrade_keeps_access', 'You keep your current plan until then.')}
                </p>
            </div>
            <button
                onClick={onUndo}
                disabled={busy}
                className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-all hover:opacity-80 disabled:opacity-50 [border-color:rgba(100,116,139,0.35)] [color:#64748b]! [background:rgba(100,116,139,0.05)]"
            >
                {busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : t('org.keep_current_plan', 'Keep current plan')}
            </button>
        </div>
    );
}

/**
 * Scheduled-cancel banner, shown when Stripe (or this user) has set
 * cancel_at_period_end. The org keeps access until cancel_at; Reactivate
 * clears the flag.
 */
export function ScheduledCancelBanner({ sub, busy, onUndo }: UndoBannerProps) {
    const { t, fmtDate } = useLicenseText();
    return (
        <div
            className="rounded-2xl border px-4 py-3 flex items-center gap-3 [border-color:rgba(59,130,246,0.3)] [background:rgba(59,130,246,0.06)]"
        >
            <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: '#3b82f6' }} />
            <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('org.cancel_scheduled', 'Subscription cancels on')} {sub.cancel_at ? fmtDate(sub.cancel_at) : t('org.period_end', 'the end of this period')}.
                </p>
                <p className="text-[11.5px] text-[var(--text-muted)]">
                    {t('org.cancel_keeps_access', 'You keep access until that date.')}
                </p>
            </div>
            <button
                onClick={onUndo}
                disabled={busy}
                className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-all hover:opacity-80 disabled:opacity-50 [border-color:rgba(59,130,246,0.3)] [color:#3b82f6]! [background:rgba(59,130,246,0.05)]"
            >
                {busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : t('org.keep_subscription', 'Keep subscription')}
            </button>
        </div>
    );
}

/** A paying sub with no plan to change to (and nothing pending). */
export function HighestPlanNotice() {
    const { t } = useLicenseText();
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 text-[12px] text-[var(--text-muted)]">
            {t('org.on_highest_plan', "You're on the highest plan — contact")} <a href="mailto:info@beeflow.nl" className="text-[#3b82f6] hover:underline">info@beeflow.nl</a> {t('org.for_custom_pricing', 'for custom pricing.')}
        </div>
    );
}

/**
 * Upgrade CTA — surfaces when AI usage cost approaches the plan cap. The
 * button opens the plan picker on this page; there is no other place an org
 * admin can change plan, so without one there is no button.
 */
export function UsageUpgradeCta({ pct, onUpgrade }: { pct: number; onUpgrade: (() => void) | null }) {
    const { t } = useLicenseText();
    return (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-center gap-3">
            <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
            <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('admin_org.license_budget_used', "You've used {pct}% of your AI usage budget this period.", { pct })}
                </p>
                <p className="text-[11.5px] text-[var(--text-muted)]">{t('admin_org.license_upgrade_hint', 'Upgrade to a higher plan for more AI usage.')}</p>
            </div>
            {onUpgrade && (
                <button
                    type="button"
                    onClick={onUpgrade}
                    className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-90 transition-opacity"
                >
                    {t('admin_org.license_upgrade_plan', 'Upgrade plan')}
                </button>
            )}
        </div>
    );
}
