// Spend in the cloud customer view: tokens and call counts are absent from the
// redacted payload, so this shows AI usage against the plan's cap, the plan and
// billing, and shares by member, tier and app area instead of a model table.

import { Activity, Cpu, Users, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { TIER_META, tierLabel } from '@/components/licensing/tierMeta';
import { useTranslation } from '@/hooks/useTranslation';
import { currencySym, formatDateRange } from '../format';
import type { OverviewTabProps, SubscriptionInfo, TimelineRow } from '../OverviewTab.types';
import { Avatar, getSourceDetails } from '../widgets';
import { paletteColor } from '@/config/analyticsConfig';
import { CostPerDayChart } from './CostPerDayChart';
import { ShareBar } from './ShareBar';
import { share } from './spendFormat';
import { CARD } from './tableStyle';

type Props = Pick<OverviewTabProps, 'data' | 'subscription' | 'tierForModel' | 'modelTiers'>;

interface ShareRow { id: string; label: string; pct: number; lead: ReactNode }

function ShareList({ title, icon: Icon, rows, empty }: { title: string; icon: LucideIcon; rows: ShareRow[]; empty: string }) {
    return (
        <article className={`${CARD} min-w-0 overflow-hidden`}>
            <h3 className="m-0 flex items-center gap-1.5 px-4 pb-1 pt-4 text-[13px] font-semibold text-[var(--text-primary)]">
                <Icon className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />{title}
            </h3>
            {rows.length === 0 ? <p className="m-0 px-4 py-3 text-xs text-[var(--text-muted)]">{empty}</p> : (
                <ul className="m-0 list-none p-0">
                    {rows.map(r => (
                        <li key={r.id} className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-4 py-2.5 first:border-t-0">
                            <span className="flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                                {r.lead}<span className="truncate">{r.label}</span>
                            </span>
                            <span className="pl-2.5 text-[13px] font-bold tabular-nums text-[var(--text-primary)]">{r.pct}%</span>
                        </li>
                    ))}
                </ul>
            )}
        </article>
    );
}

function Badge({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-[var(--bg-tertiary)]">
            <Icon className="h-[13px] w-[13px]" aria-hidden="true" ref={el => el?.style.setProperty('color', color)} />
        </span>
    );
}

function capTone(pct: number | null): string {
    if (pct == null || pct < 80) return 'var(--success)';
    return pct >= 95 ? 'var(--error)' : 'var(--warning)';
}

function PlanCards({ sub, sym }: { sub: SubscriptionInfo | null; sym: string }) {
    const { t } = useTranslation();
    const billing = sub?.billing || null;
    const interval = billing?.billing_interval === 'yearly' ? t('usage.cust_year', 'year') : t('usage.cust_month', 'month');
    return (
        <div className="flex min-w-[200px] flex-col gap-2">
            <div className="rounded-lg bg-[var(--bg-secondary)] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{t('usage.plan', 'Plan')}</div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">{sub?.plan_name || '—'}</div>
            </div>
            <div className="rounded-lg bg-[var(--bg-secondary)] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{t('usage.billed_per_cycle', 'Billed per cycle')}</div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">{sym}{Number(billing?.subscription_total || 0).toFixed(2)}</div>
                <div className="text-[11px] text-[var(--text-muted)]">
                    {billing?.per_seat ? `${billing.seat_quantity} × ${sym}${Number(billing.plan_price || 0).toFixed(2)} / ${t('usage.cust_seat', 'seat')}` : `/ ${interval}`}
                </div>
            </div>
        </div>
    );
}

/** Usage against the cap, anchored to the billing period so it matches the License page (both = current_usage.cost / cap). */
function capUsage(sub: SubscriptionInfo | null): { cap: number; pct: number | null } {
    const cap = Number(sub?.effective_limits?.max_cost_per_month) || 0;
    const periodCost = Number(sub?.current_usage?.cost || 0);
    return { cap, pct: cap > 0 ? Math.min(100, Math.round((periodCost / cap) * 100)) : null };
}

function CapBar({ pct }: { pct: number }) {
    const { t } = useTranslation();
    return (
        <div className="mt-2 flex flex-col gap-1.5">
            <div className="flex justify-between text-[11px] font-semibold text-[var(--text-secondary)]">
                <span>{t('usage.ai_usage_vs_cap', 'AI usage vs. cap')}</span><span>{pct}%</span>
            </div>
            <ShareBar height={8} parts={[{ pct, color: capTone(pct) }]} />
        </div>
    );
}

function CapHero({ data, sub, sym }: { data: Props['data']; sub: SubscriptionInfo | null; sym: string }) {
    const { t } = useTranslation();
    const { pct } = capUsage(sub);
    const activeUsers = data.summary?.unique_users || data.users?.length || 0;
    const period = sub?.billing_period ? formatDateRange(sub.billing_period.startDate, sub.billing_period.endDate) : '';
    return (
        <section className={`${CARD} flex flex-wrap gap-6 p-6`}>
            <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-2">
                <p className="m-0 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{t('usage.ai_usage_this_period', 'AI usage this period')}</p>
                <div className="flex flex-wrap items-baseline gap-3">
                    <span className="text-5xl font-semibold leading-none tracking-tight text-[var(--text-primary)]">{pct == null ? '—' : `${pct}%`}</span>
                    {sub?.status && <span className="rounded-md bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[.06em] text-[var(--text-secondary)]">{sub.status}</span>}
                </div>
                <p className="m-0 text-[13px] text-[var(--text-muted)]">{activeUsers} {t('usage.active_users', 'active users')}{period ? ` · ${period}` : ''}</p>
                {pct != null && <CapBar pct={pct} />}
            </div>
            <PlanCards sub={sub} sym={sym} />
        </section>
    );
}

export function CustomerSpend({ data, subscription, tierForModel, modelTiers }: Props) {
    const { t } = useTranslation();
    const sub = subscription as SubscriptionInfo | null;
    const sym = currencySym(sub?.billing?.plan_currency || 'EUR');
    const billed = (v: number | null | undefined) => Number(v || 0);
    const totalBilled = billed(data.summary?.billed_cost);
    const byBilled = <R extends { billed_cost?: number | null }>(rows: R[]) => [...rows].sort((a, b) => billed(b.billed_cost) - billed(a.billed_cost)).slice(0, 8);

    const userRows: ShareRow[] = byBilled(data.users || []).map((u, i) => ({
        id: u.user_id, label: u.display_name || u.user_id, pct: share(billed(u.billed_cost), totalBilled),
        lead: <Avatar user={u} color={paletteColor(i)} />,
    }));
    const areaRows: ShareRow[] = byBilled(data.sources || []).map((s) => {
        const d = getSourceDetails(s.source, t);
        return { id: s.source, label: d.label, pct: share(billed(s.billed_cost), totalBilled), lead: <Badge icon={d.icon} color={d.color} /> };
    });

    // Customers never see raw model ids: roll the model rows up into the tier they picked.
    const other = t('usage.tier_other', 'Other');
    const tiers = new Map<string, { label: string; tierKey: string | null; cost: number }>();
    for (const m of data.models || []) {
        const tierKey = tierForModel?.(m.model) || null;
        const label = (tierKey ? tierLabel(tierKey, modelTiers as Parameters<typeof tierLabel>[1]) : '') || other;
        const bucket = tiers.get(label) || { label, tierKey, cost: 0 };
        bucket.cost += billed(m.billed_cost);
        tiers.set(label, bucket);
    }
    const tierRows: ShareRow[] = [...tiers.values()].sort((a, b) => b.cost - a.cost).slice(0, 8).map((b, i) => ({
        id: b.label, label: b.label, pct: share(b.cost, totalBilled),
        lead: <Badge icon={(b.tierKey && TIER_META[b.tierKey]?.Icon) || Cpu} color={paletteColor(i)} />,
    }));

    return (
        <div className="flex flex-col gap-4">
            <CapHero data={data} sub={sub} sym={sym} />
            <section className={`${CARD} p-5`}>
                <CostPerDayChart timeline={(data.timeline || []) as TimelineRow[]} currency={sym} isCustomerView />
            </section>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))]">
                <ShareList title={t('usage.top_users_by_cost', 'Top users by cost')} icon={Users} rows={userRows} empty={t('usage.no_active_users')} />
                <ShareList title={t('usage.by_tier', 'By tier')} icon={Cpu} rows={tierRows} empty={t('usage.no_model_data')} />
                <ShareList title={t('usage.by_app_area', 'By app area')} icon={Activity} rows={areaRows} empty={t('usage.no_usage_recorded', 'No usage recorded yet')} />
            </div>
        </div>
    );
}
