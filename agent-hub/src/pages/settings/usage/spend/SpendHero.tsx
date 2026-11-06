// The Spend hero: the period's estimated cost with its change, how it splits
// into input and output, the monthly budget, and the cost per day.

import { useTranslation } from '@/hooks/useTranslation';
import { DeltaPill, Swatch } from '../shell';
import { fInt, fMoney } from '../adoption/format';
import { fNum } from '../format';
import type { OverviewTabProps, SubscriptionInfo, TimelineRow } from '../OverviewTab.types';
import { CostPerDayChart } from './CostPerDayChart';
import { IN_COLOR, OUT_COLOR, ShareBar } from './ShareBar';
import { headlineCost, perDay } from './spendFormat';
import { CARD } from './tableStyle';

const USERS_SETTINGS_PATH = '/app/settings/organisation/users';

interface SpendHeroProps {
    data: OverviewTabProps['data'];
    subscription: Record<string, unknown> | null;
    showTokens: boolean;
    currency: string;
    rangeLabel: string;
    /** Change of the spend against the previous period, in percent; null when unknown. */
    deltaPct: number | null;
    showDelta: boolean;
    /** Days in the period; null for the "all" preset. */
    days: number | null;
}

function budgetTone(pct: number): string {
    if (pct >= 95) return 'var(--error)';
    if (pct >= 80) return 'var(--warning)';
    return 'var(--success)';
}

function BudgetLine({ subscription, currency }: { subscription: Record<string, unknown> | null; currency: string }) {
    const { t } = useTranslation();
    const sub = subscription as SubscriptionInfo | null;
    const cap = Number(sub?.effective_limits?.max_cost_per_month) || 0;
    const used = Number(sub?.current_usage?.cost) || 0;
    const hasCap = cap > 0;
    const pct = hasCap ? Math.min(100, (used / cap) * 100) : 0;
    return (
        <div className="mt-2 flex flex-col gap-1.5">
            <div className="flex justify-between text-xs text-[var(--text-muted)]">
                <span>{t('usage.spend_budget', 'Monthly budget')}</span>
                <span>{hasCap
                    ? t('usage.spend_budget_of', '{used} of {cap}', { used: fMoney(used, currency), cap: fMoney(cap, currency) })
                    : t('usage.spend_budget_none', 'none set')}</span>
            </div>
            <ShareBar parts={hasCap ? [{ pct, color: budgetTone(pct) }] : []} />
            {!hasCap && (
                <a href={USERS_SETTINGS_PATH} className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium text-[var(--accent-primary)] hover:underline">
                    {t('usage.spend_budget_link', 'Set a budget per member or group')} <span aria-hidden="true">→</span>
                </a>
            )}
        </div>
    );
}

export function SpendHero({ data, subscription, showTokens, currency, rangeLabel, deltaPct, showDelta, days }: SpendHeroProps) {
    const { t } = useTranslation();
    const timeline = (data.timeline || []) as TimelineRow[];
    const cost = headlineCost(data.summary, false);
    const costPerDay = perDay(cost, days, timeline);
    const azure = Number(data.summary?.azure_services_total_cost) || 0;
    const facts = [
        t('usage.ov_cost_per_day', '{cost} per day', { cost: fMoney(costPerDay, currency) }),
        showTokens && t('usage.spend_n_calls', '{n} calls', { n: fInt(data.summary?.total_calls) }),
        showTokens && t('usage.ov_tokens', '{n} tokens', { n: fNum(data.summary?.total_tokens) }),
    ].filter(Boolean).join(' · ');
    return (
        <section aria-label={t('usage.spend_summary', 'Spend summary')} className={`${CARD} flex flex-wrap gap-x-10 gap-y-6 p-6`}>
            <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-3">
                <p className="m-0 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">
                    {rangeLabel ? t('usage.spend_hero_label_range', 'Estimated AI cost · {range}', { range: rangeLabel }) : t('usage.spend_hero_label', 'Estimated AI cost')}
                </p>
                <div className="flex flex-wrap items-baseline gap-3.5">
                    <span className="text-5xl font-semibold leading-none tracking-tight text-[var(--text-primary)]">{fMoney(cost, currency)}</span>
                    <DeltaPill delta={deltaPct} unit="pct" goodWhenDown compare={showDelta} />
                    {showDelta && deltaPct != null && <span className="text-xs text-[var(--text-muted)]">{t('usage.spend_vs_previous', 'vs previous period')}</span>}
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-[var(--text-secondary)]">
                    <span className="inline-flex items-center gap-1.5"><Swatch color={IN_COLOR} />{t('usage.spend_input_cost', 'Input {cost}', { cost: fMoney(data.summary?.total_input_cost, currency) })}</span>
                    <span className="inline-flex items-center gap-1.5"><Swatch color={OUT_COLOR} />{t('usage.spend_output_cost', 'Output {cost}', { cost: fMoney(data.summary?.total_output_cost, currency) })}</span>
                    {azure > 0 && <span className="inline-flex items-center gap-1.5"><Swatch color="var(--accent-primary)" />{t('usage.spend_azure_cost', 'Azure services {cost}', { cost: fMoney(azure, currency) })}</span>}
                </div>
                <p className="m-0 text-[13px] text-[var(--text-muted)]">{facts}</p>
                <BudgetLine subscription={subscription} currency={currency} />
            </div>
            <div className="min-w-0 flex-[2_1_360px]">
                <CostPerDayChart timeline={timeline} currency={currency} />
            </div>
        </section>
    );
}
