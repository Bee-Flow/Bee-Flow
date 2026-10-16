import { BarChart3, Bot, CreditCard, Database, DollarSign, Info, Loader2, Plus, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { intervalLabel, useLicenseText } from './licenseShared';
import type { OrgSubscription, PlanLimits, SubscriptionBilling } from './licenseShared';
import { currencySym, UsageBar } from '../orgInfoShared';

const ADD_USER_STYLE = { borderColor: 'rgba(59,130,246,0.3)', color: '#3b82f6', background: 'rgba(59,130,246,0.05)' };

function SeatsHint({ className }: { className: string }) {
    const { t } = useLicenseText();
    return (
        <div className={className}>
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{t('org.add_user_hint', 'Inviting a user adds a seat to your plan. Extra seats are billed per user per month and prorated for the current period.')} {t('org.seats_proration_note', 'Stripe prorates the difference on your next invoice.')}</span>
        </div>
    );
}

function PerSeatLine({ billing, onAddUser }: { billing: SubscriptionBilling; onAddUser: () => void }) {
    const { t } = useLicenseText();
    return (
        <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
            <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--text-muted)]">
                    {billing.seat_quantity} × {currencySym(billing.plan_currency)}{Number(billing.plan_price).toFixed(2)} {t('org.per_seat', '/ seat')}
                </span>
                <span className="flex items-center gap-2">
                    <span className="text-[var(--text-secondary)] font-medium">
                        {billing.seat_quantity} {billing.seat_quantity === 1 ? t('org.seat', 'seat') : t('org.seats', 'seats')}
                    </span>
                    {/* BFSF-251: the Add-user CTA must exist on EVERY
                        per-seat sub — the plan-limits card below filters
                        out unlimited (-1/null) tiles, so per-seat plans
                        without a finite max_users lost the CTA entirely. */}
                    <button
                        type="button"
                        onClick={onAddUser}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border transition-all hover:opacity-80"
                        style={ADD_USER_STYLE}
                    >
                        <Plus className="w-3 h-3" /> {t('org.add_user', 'Add user')}
                    </button>
                </span>
            </div>
            <SeatsHint className="mt-2 flex items-start gap-2 text-[11px] text-[var(--text-muted)]" />
        </div>
    );
}

interface BillingCardProps {
    sub: OrgSubscription;
    billing: SubscriptionBilling;
    cancelBusy: boolean;
    onCancel: () => void;
    onAddUser: () => void;
}

/** What the subscription costs per cycle, its seats, and the cancel action. */
export function BillingCard({ sub, billing, cancelBusy, onCancel, onAddUser }: BillingCardProps) {
    const { t } = useLicenseText();
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-[var(--text-muted)]" />
                {t('org.subscription', 'Subscription')}
            </h3>
            <div className="flex items-baseline justify-between">
                <span className="text-[12px] text-[var(--text-muted)]">{t('org.billed_per_cycle', 'Billed per cycle')}</span>
                <span className="text-2xl font-bold text-[var(--text-primary)]">
                    {currencySym(billing.plan_currency)}{Number(billing.subscription_total).toFixed(2)}
                    <span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">/ {intervalLabel(t, billing.billing_interval)}</span>
                </span>
            </div>
            {billing.per_seat && <PerSeatLine billing={billing} onAddUser={onAddUser} />}
            {/* Cancel-at-period-end action. Muted — destructive but reversible
                (the Reactivate banner appears on success). Hidden during the
                scheduled-cancel window since the banner has its own undo CTA. */}
            {sub.stripe_subscription_id && sub.status === 'active' && !sub.cancel_at_period_end && (
                <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] flex justify-end">
                    <button
                        onClick={onCancel}
                        disabled={cancelBusy}
                        className="text-[11.5px] font-medium text-[#64748b] hover:text-[var(--text-primary)] disabled:opacity-50 transition-colors"
                    >
                        {cancelBusy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : t('org.cancel_subscription', 'Cancel subscription')}
                    </button>
                </div>
            )}
        </div>
    );
}

/** Usage this period — AI usage shown as % of the cap only (no € amount). */
export function UsageCard({ used, limit }: { used: number; limit: number | null | undefined }) {
    const { t } = useLicenseText();
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-4">
            <div className="flex items-center gap-2 mb-1">
                <BarChart3 className="w-4 h-4 text-[var(--text-muted)]" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('org.usage_this_period')}</h3>
            </div>

            <UsageBar
                label={t('org.ai_usage', 'AI usage')}
                icon={DollarSign}
                used={used}
                limit={limit}
                color="#10b981"
                percentOnly
            />
        </div>
    );
}

interface LimitItem {
    key: 'users' | 'agents' | 'knowledge';
    label: string;
    icon: LucideIcon;
    val: number;
    color: string;
}

function LimitTile({ item, seatQuantity, showAddUser, onAddUser }: { item: LimitItem; seatQuantity: number | null | undefined; showAddUser: boolean; onAddUser: () => void }) {
    const { t } = useLicenseText();
    const Icon = item.icon;
    return (
        <div className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${item.color}10` }}>
                <Icon className="w-4 h-4" style={{ color: item.color }} />
            </div>
            <div>
                <div className="text-sm font-bold text-[var(--text-primary)]">
                    {/* BFSF-251: on the Users tile show LIVE seats vs the
                        plan limit, not the bare cap — "1 Gebruiker" told
                        the reporter nothing about usage or headroom. */}
                    {item.key === 'users' && seatQuantity != null
                        ? `${seatQuantity} / ${Number(item.val).toLocaleString()}`
                        : Number(item.val).toLocaleString()}
                </div>
                <div className="text-[10px] text-[var(--text-muted)]">{item.label}</div>
            </div>
            {/* BFSF-251: direct seat/user add from the Users card —
                unless the billing card above already offers it. */}
            {item.key === 'users' && showAddUser && (
                <button
                    type="button"
                    onClick={onAddUser}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border transition-all hover:opacity-80"
                    style={ADD_USER_STYLE}
                >
                    <Plus className="w-3 h-3" /> {t('org.add_user', 'Add user')}
                </button>
            )}
        </div>
    );
}

interface PlanLimitsCardProps {
    sub: OrgSubscription;
    limits: PlanLimits;
    /** The billing card already carries "Add user" and the seat hint. */
    billingCardHasSeats: boolean;
    onAddUser: () => void;
}

/**
 * Plan limits grid — only renders concrete caps; ∞ tiles are hidden, and the
 * whole card collapses when no limits are set and there are no notes.
 */
export function PlanLimitsCard({ sub, limits, billingCardHasSeats, onAddUser }: PlanLimitsCardProps) {
    const { t } = useLicenseText();
    const limitItems = ([
        { key: 'users', label: t('org.users'), icon: Users, val: limits.max_users, color: '#3b82f6' },
        { key: 'agents', label: t('org.agents'), icon: Bot, val: limits.max_agents, color: '#f59e0b' },
        { key: 'knowledge', label: t('org.knowledge_sources'), icon: Database, val: limits.max_knowledge_sources, color: '#10b981' },
    ] as Array<Omit<LimitItem, 'val'> & { val: number | null | undefined }>)
        .filter((it): it is LimitItem => it.val !== null && it.val !== undefined && it.val !== -1);
    if (limitItems.length === 0 && !sub.notes) return null;
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">{t('org.plan_limits')}</h3>
            {limitItems.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                    {limitItems.map(item => (
                        <LimitTile
                            key={item.label}
                            item={item}
                            seatQuantity={sub.billing?.seat_quantity}
                            showAddUser={!billingCardHasSeats}
                            onAddUser={onAddUser}
                        />
                    ))}
                </div>
            )}
            {/* BFSF-251: per-seat plans bill each invited user; surface how the
                proration works so adding a seat isn't a surprise on the invoice. */}
            {sub.billing?.per_seat && !billingCardHasSeats && (
                <SeatsHint className="mt-3 flex items-start gap-2 text-[11px] text-[var(--text-muted)]" />
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
}
