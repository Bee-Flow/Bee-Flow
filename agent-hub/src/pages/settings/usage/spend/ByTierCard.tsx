// "By tier": the models rolled up into the tier a person picks (Fast, Standard,
// Thinking, ...). Shown under the model table, where the tiers are named.

import { tierLabel } from '@/components/licensing/tierMeta';
import { chartSeriesVar } from '@/components/shared/charts/chartChrome';
import { useTranslation } from '@/hooks/useTranslation';
import { SegmentBar } from '../shell';
import { fInt, fMoney } from '../adoption/format';
import type { ModelRow } from '../OverviewTab.types';
import type { SpendViewProps } from './spend.types';
import { costOf, share } from './spendFormat';
import { CARD } from './tableStyle';

interface TierBucket { label: string; cost: number; calls: number }

export function tierBuckets(models: ModelRow[], { tierForModel, modelTiers }: Pick<SpendViewProps, 'tierForModel' | 'modelTiers'>, other: string): TierBucket[] {
    const map = new Map<string, TierBucket>();
    for (const m of models) {
        const key = tierForModel?.(m.model) || null;
        const label = (key ? tierLabel(key, modelTiers as Parameters<typeof tierLabel>[1]) : '') || other;
        const b = map.get(label) || { label, cost: 0, calls: 0 };
        b.cost += costOf(m);
        b.calls += Number(m.calls) || 0;
        map.set(label, b);
    }
    return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function ByTierCard(props: SpendViewProps) {
    const { t } = useTranslation();
    const { currency } = props;
    const buckets = tierBuckets(props.data.models || [], props, t('usage.tier_other', 'Other'));
    if (buckets.length === 0) return null;
    const cost = buckets.reduce((s, b) => s + b.cost, 0);
    const calls = buckets.reduce((s, b) => s + b.calls, 0);
    const top = buckets[0];
    const showStory = buckets.length > 1 && share(top.calls, calls) < share(top.cost, cost);
    return (
        <article className={`${CARD} flex min-w-0 flex-col gap-3 px-6 py-5`}>
            <h3 className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">{t('usage.by_tier', 'By tier')}</h3>
            <SegmentBar height={10} segments={buckets.map((b, i) => ({ value: b.cost, color: chartSeriesVar(i), label: b.label }))} />
            <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-[13px] text-[var(--text-primary)]">
                {buckets.map((b, i) => (
                    <li key={b.label} className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" ref={el => el?.style.setProperty('background-color', chartSeriesVar(i))} />
                        {b.label} <strong>{fMoney(b.cost, currency)}</strong>
                        <span className="text-[var(--text-muted)]">{t('usage.spend_n_calls', '{n} calls', { n: fInt(b.calls) })}</span>
                    </li>
                ))}
            </ul>
            {showStory && (
                <p className="m-0 text-[13px] text-[var(--text-secondary)]">
                    {t('usage.spend_tier_story', '{calls}% of calls made {cost}% of the cost ({tier}).', { calls: share(top.calls, calls), cost: share(top.cost, cost), tier: top.label })}
                </p>
            )}
        </article>
    );
}
