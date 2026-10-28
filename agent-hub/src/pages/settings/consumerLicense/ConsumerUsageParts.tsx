import { BarChart3, Bot, Check, CreditCard, Crown, Database, DollarSign, ExternalLink, Loader2, Sparkles, type LucideIcon } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { formatCompact, isUnlimitedLimit, type CheckoutMessage, type ConsumerUsageData } from './consumerBilling';

/** Usage bar (matches OrgInfoPanel style). */
function UsageBar({ label, icon: Icon, used, limit, unit, color = '#3b82f6', percentOnly = false }: {
    label: string;
    icon: LucideIcon;
    used: number;
    limit: number | null | undefined;
    unit?: string;
    color?: string;
    percentOnly?: boolean;
}) {
    const { t } = useTranslation();
    const isUnlimited = isUnlimitedLimit(limit);
    const pct = isUnlimited || !limit ? 0 : limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const isWarning = pct >= 80 && pct < 95;
    const isCritical = pct >= 95;
    const barColor = isCritical ? '#ef4444' : isWarning ? '#f59e0b' : color;
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                    <Icon className="w-3.5 h-3.5" style={{ color }} />
                    {label}
                </div>
                {!percentOnly && (
                    <span className="text-xs text-[var(--text-muted)]">
                        {formatCompact(used)}{unit ? ` ${unit}` : ''} / {formatCompact(limit)}{unit ? ` ${unit}` : ''}
                    </span>
                )}
            </div>
            <div className="h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                        width: isUnlimited ? '0%' : `${pct}%`,
                        background: isUnlimited ? 'transparent' : barColor,
                    }}
                />
            </div>
            {!isUnlimited && (
                <div className="flex justify-end">
                    <span className={`text-[10px] font-medium ${isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : 'text-[var(--text-muted)]'}`}>
                        {t('settings.consumer_license.pct_used', '{pct}% used', { pct })}
                    </span>
                </div>
            )}
        </div>
    );
}

export function ConsumerLicenseSkeleton() {
    return (
        <div className="space-y-6 animate-pulse">
            <div className="h-6 w-48 bg-[var(--bg-tertiary)] rounded-lg" />
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-4">
                {[1, 2, 3].map(i => (
                    <div key={i} className="space-y-2">
                        <div className="h-4 w-24 bg-[var(--bg-tertiary)] rounded" />
                        <div className="h-2 w-full bg-[var(--bg-tertiary)] rounded-full" />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** Checkout result banner (success / cancelled / error). */
export function CheckoutBanner({ message, onDismiss }: { message: CheckoutMessage; onDismiss: () => void }) {
    const success = message.type === 'success';
    return (
        <div className={`rounded-xl p-4 flex items-center gap-3 ${success ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-amber-500/10 border border-amber-500/30'}`}>
            {success ? <Check className="w-5 h-5 text-emerald-500 shrink-0" /> : <CreditCard className="w-5 h-5 text-amber-500 shrink-0" />}
            <span className={`text-sm font-medium ${success ? 'text-emerald-400' : 'text-amber-400'}`}>
                {message.text}
            </span>
            <button
                onClick={onDismiss}
                className="ml-auto text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >✕</button>
        </div>
    );
}

interface PlanSummaryCardProps {
    planName?: string;
    trialing: boolean;
    hasActiveSub: boolean;
    daysLeft: number | null;
    showPortal: boolean;
    portalLoading: boolean;
    onPortal: () => void;
}

/** The current plan, the billing period and (for paying customers) Manage billing. */
export function PlanSummaryCard({ planName, trialing, hasActiveSub, daysLeft, showPortal, portalLoading, onPortal }: PlanSummaryCardProps) {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
            <div className="p-5">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{
                            background: hasActiveSub ? '#10b981' : '#3b82f6',
                        }}>
                            {hasActiveSub ? <Crown className="w-5 h-5 text-white" /> : <CreditCard className="w-5 h-5 text-white" />}
                        </div>
                        <div>
                            <p className="text-sm font-semibold text-[var(--text-primary)]">
                                {planName === '__consumer_default__' ? 'Free' : (planName || 'Free')}
                                {trialing && (
                                    <span className="ml-2 text-[10px] font-bold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full">{t('settings.consumer_license.trial_badge', 'TRIAL')}</span>
                                )}
                            </p>
                            <p className="text-xs text-[var(--text-muted)]">
                                {daysLeft !== null ? `${daysLeft} days remaining in billing period` : 'Monthly billing'}
                            </p>
                        </div>
                    </div>
                    {/* Manage Billing button — only for paying customers (BFSF-241) */}
                    {showPortal && (
                        <button
                            onClick={onPortal}
                            disabled={portalLoading}
                            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors [color:#3b82f6]! [border-color:rgba(59,130,246,0.3)] [background:rgba(59,130,246,0.05)]"
                        >
                            {portalLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                            {t('license.manage_billing', 'Manage billing')}
                        </button>
                    )}
                </div>
            </div>
            {/* The AI-usage percentage is shown once, as the "Usage This
                Period" bar below (absolute € intentionally hidden). */}
        </div>
    );
}

/** Upgrade CTA — surfaces when AI usage cost approaches the plan cap. */
export function UpgradeCta({ costPct, onUpgrade }: { costPct: number; onUpgrade: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-center gap-3">
            <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
            <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('settings.consumer_license.budget_used', "You've used {pct}% of your AI usage budget this period.", { pct: costPct })}
                </p>
                <p className="text-[11.5px] text-[var(--text-muted)]">{t('settings.consumer_license.budget_upgrade_hint', 'Upgrade to a higher plan for more AI usage.')}</p>
            </div>
            <button
                onClick={onUpgrade}
                className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
                {t('settings.consumer_license.upgrade_plan', 'Upgrade plan')}
            </button>
        </div>
    );
}

type Limits = NonNullable<ConsumerUsageData['limits']>;

/** Usage bars — AI usage cost only. */
export function UsageThisPeriod({ billedCost, limits }: { billedCost: number; limits: Limits | null | undefined }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-4">
            <div className="flex items-center gap-2 mb-1">
                <BarChart3 className="w-4 h-4 text-[var(--text-muted)]" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('settings.consumer_license.usage_this_period', 'Usage This Period')}</h3>
            </div>
            <UsageBar label={t('org.ai_usage', 'AI usage')} icon={DollarSign} used={billedCost} limit={limits?.max_cost_per_month} color="#10b981" percentOnly />
        </div>
    );
}

/** The plan's counted limits (agents, knowledge sources). */
export function PlanLimitsGrid({ limits }: { limits: Limits | null | undefined }) {
    const { t } = useTranslation();
    const items = [
        { label: 'Agents', icon: Bot, val: limits?.max_agents, color: '#f59e0b' },
        { label: 'Knowledge Sources', icon: Database, val: limits?.max_knowledge_sources, color: '#10b981' },
    ];
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">{t('settings.consumer_license.plan_limits', 'Plan Limits')}</h3>
            <div className="grid grid-cols-2 gap-3">
                {items.map(item => {
                    const Icon = item.icon;
                    return (
                        <div key={item.label} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
                            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${item.color}10` }}>
                                <Icon className="w-4 h-4" style={{ color: item.color }} />
                            </div>
                            <div>
                                <div className="text-sm font-bold text-[var(--text-primary)]">
                                    {isUnlimitedLimit(item.val) ? '∞' : item.val?.toLocaleString()}
                                </div>
                                <div className="text-[10px] text-[var(--text-muted)]">{item.label}</div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
