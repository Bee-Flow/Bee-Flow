// The four numbers of the Overview: spend, AI-active members, AI calls and
// dormant seats. The adoption tiles need the adoption reads (licence feature),
// the call tile needs call counts (absent in the redacted customer view).

import { useTranslation } from '@/hooks/useTranslation';
import { KpiTile, SegmentBar } from '../shell';
import { fNum } from '../format';
import { fInt, fMoney } from '../adoption/format';
import type { OverviewTabProps, TimelineRow } from '../OverviewTab.types';
import { headlineCost, pctChange, share, timelineCalls, timelineCost } from '../spend/spendFormat';
import type { OverviewAdoption } from './adoptionData';
import { MiniTrend } from './MiniTrend';

interface KpiRowProps {
    data: OverviewTabProps['data'];
    adoption: OverviewAdoption | null;
    isCustomerView: boolean;
    showTokens: boolean;
    currency: string;
    /** Deltas are on: compare is switched on and no cross-cutting filter narrows the usage figures. */
    showDelta: boolean;
    onOpenTab: (tab: string, subTab?: string) => void;
}

function perDay(total: number, days: number): number {
    return days > 0 ? total / days : 0;
}

function SpendTile({ data, adoption, isCustomerView, currency, showDelta, onOpenTab }: KpiRowProps) {
    const { t } = useTranslation();
    const timeline = (data.timeline || []) as TimelineRow[];
    const cost = headlineCost(data.summary, isCustomerView);
    const spend = adoption?.summary?.spend.cost;
    const prev = adoption?.summary?.prev?.cost;
    const parts = [
        !isCustomerView && t('usage.ov_in_cost', 'In {cost}', { cost: fMoney(data.summary?.total_input_cost, currency) }),
        !isCustomerView && t('usage.ov_out_cost', 'Out {cost}', { cost: fMoney(data.summary?.total_output_cost, currency) }),
        t('usage.ov_cost_per_day', '{cost} per day', { cost: fMoney(perDay(cost, timeline.length), currency) }),
    ].filter(Boolean);
    return (
        <KpiTile
            label={t('usage.ov_tile_spend', 'AI spend')}
            value={fMoney(cost, currency)}
            delta={{ delta: spend == null ? null : pctChange(spend, prev), unit: 'pct', goodWhenDown: true }}
            compare={showDelta}
            secondary={parts.join(' · ')}
            more={{ label: t('usage.ov_open_spend', 'Open Spend'), onClick: () => onOpenTab('spend') }}
        >
            <MiniTrend values={timeline.map(r => timelineCost(r, isCustomerView))} />
        </KpiTile>
    );
}

function MembersTile({ adoption, showDelta, onOpenTab }: KpiRowProps) {
    const { t } = useTranslation();
    const s = adoption?.summary;
    if (!s) return null;
    const makers = s.makers.total === 1
        ? t('usage.ov_maker_one', '1 maker')
        : t('usage.ov_makers', '{n} makers', { n: fInt(s.makers.total) });
    return (
        <KpiTile
            label={t('usage.ov_tile_active', 'AI-active members')}
            value={`${Math.round(s.adoptionRate)}%`}
            delta={{ delta: s.prev ? s.adoptionRate - s.prev.adoptionRate : null, unit: 'pts' }}
            compare={showDelta}
            secondary={`${t('usage.ov_members_used', '{used} of {total} members used AI', { used: fInt(s.members.aiActive), total: fInt(s.members.total) })} · ${makers}`}
            more={{ label: t('usage.ov_open_adoption', 'Open Adoption'), onClick: () => onOpenTab('adoption') }}
        >
            <div className="my-1.5">
                <SegmentBar
                    segments={[
                        { value: s.members.aiActive, color: 'var(--text-primary)', label: t('usage.ov_seg_active', 'AI-active') },
                        { value: Math.max(0, s.members.total - s.members.aiActive), color: 'var(--border-default)', label: t('usage.ov_seg_rest', 'Not active') },
                    ]}
                />
            </div>
        </KpiTile>
    );
}

function CallsTile({ data, showTokens, onOpenTab }: KpiRowProps) {
    const { t } = useTranslation();
    const timeline = (data.timeline || []) as TimelineRow[];
    const calls = Number(data.summary?.total_calls || 0);
    const parts = [
        showTokens && t('usage.ov_tokens', '{n} tokens', { n: fNum(data.summary?.total_tokens) }),
        t('usage.ov_calls_per_day', '{n} calls per day', { n: perDay(calls, timeline.length).toFixed(1) }),
    ].filter(Boolean);
    return (
        <KpiTile
            label={t('usage.ov_tile_calls', 'AI calls')}
            value={fInt(calls)}
            secondary={parts.join(' · ')}
            more={{ label: t('usage.ov_open_spend', 'Open Spend'), onClick: () => onOpenTab('spend') }}
        >
            <MiniTrend values={timeline.map(timelineCalls)} />
        </KpiTile>
    );
}

function DormantTile({ adoption, onOpenTab }: KpiRowProps) {
    const { t } = useTranslation();
    const s = adoption?.summary;
    if (!s) return null;
    const dormant = s.members.dormant;
    const secondary = dormant == null
        ? t('usage.ov_dormant_unknown', 'Not available for a custom period')
        : t('usage.ov_dormant_secondary', 'No sign-in for 30+ days · {pct}% of seats', { pct: share(dormant, s.members.total) });
    return (
        <KpiTile
            label={t('usage.ov_tile_dormant', 'Dormant seats')}
            value={dormant == null ? '—' : fInt(dormant)}
            secondary={secondary}
            more={{ label: t('usage.ov_see_who', 'See who'), onClick: () => onOpenTab('adoption', 'people') }}
        >
            <div className="flex h-7 items-center" aria-hidden="true"><div className="h-px flex-1 bg-[var(--border-subtle)]" /></div>
        </KpiTile>
    );
}

export function KpiRow(props: KpiRowProps) {
    const { t } = useTranslation();
    return (
        <section aria-label={t('usage.ov_key_figures', 'Key figures')} className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr))]">
            <SpendTile {...props} />
            <MembersTile {...props} />
            {!props.isCustomerView && <CallsTile {...props} />}
            <DormantTile {...props} />
        </section>
    );
}
