import { Euro, Hammer, UserMinus, Users } from 'lucide-react';
import SplitBar from '@/components/shared/charts/SplitBar';
import { useTranslation } from '@/hooks/useTranslation';
import { MetricCard, MetricGrid, MonitorHero, TrendChip } from '../kit';
import type { AdoptionSummary } from './adoption.types';
import { fInt, fMoney, sharePct } from './format';

interface AdoptionHeroProps {
    summary: AdoptionSummary;
    currency: string;
    showCalls: boolean;
}

type T = ReturnType<typeof useTranslation>['t'];

/** The member split for the bar under the headline; seen/dormant exist only for a relative period. */
function statusSegments(m: AdoptionSummary['members'], t: T) {
    const segs = [{ label: t('adoption.hero_seg_active', 'AI-active'), n: m.aiActive }];
    if (m.seenOnly != null) segs.push({ label: t('adoption.hero_seg_seen', 'Signed in only'), n: m.seenOnly });
    if (m.dormant != null) segs.push({ label: t('adoption.hero_seg_dormant', 'Dormant > 30 d'), n: m.dormant });
    if (m.never != null) segs.push({ label: t('adoption.hero_seg_never', 'Never signed in'), n: m.never });
    return segs;
}

/** "31 makers built or changed something · 22 signed in without using AI · 19 dormant". */
function heroSentence(s: AdoptionSummary, t: T): string {
    const parts = [t('adoption.hero_makers_line', '{n} makers built or changed something', { n: fInt(s.makers.total) })];
    if (s.members.seenOnly != null) parts.push(t('adoption.hero_seen_line', '{n} members signed in without using AI', { n: fInt(s.members.seenOnly) }));
    if (s.members.dormant != null) parts.push(t('adoption.hero_dormant_line', '{n} seats dormant for more than 30 days', { n: fInt(s.members.dormant) }));
    return parts.join(' · ');
}

function HeroAside({ summary: s, currency, showCalls }: AdoptionHeroProps) {
    const { t } = useTranslation();
    const seats = s.members.seats;
    const seatLine = seats.max != null
        ? t('adoption.hero_members_sub', '+{n} joined · {max} seats licensed', { n: fInt(s.members.newInPeriod), max: fInt(seats.max) })
        : t('adoption.hero_members_sub_nomax', '+{n} joined this period', { n: fInt(s.members.newInPeriod) });
    const costDelta = s.prev && s.prev.cost > 0 ? Math.round(((s.spend.cost - s.prev.cost) / s.prev.cost) * 100) : null;
    const spendSub = [
        costDelta != null ? t('adoption.hero_spend_delta', '{delta} vs previous period', { delta: `${costDelta > 0 ? '+' : ''}${costDelta}%` }) : null,
        t('adoption.hero_spend_per', '{cost} per active member', { cost: fMoney(s.spend.perActiveMember, currency) }),
        showCalls && s.spend.calls != null ? t('adoption.hero_spend_calls', '{n} calls', { n: fInt(s.spend.calls) }) : null,
    ].filter(Boolean).join(' · ');
    return (
        <MetricGrid cols={2} gap={8}>
            <MetricCard icon={Users} color="#0ea5e9" label={t('adoption.hero_members', 'Members')} value={fInt(s.members.total)} subtitle={seatLine} />
            <MetricCard
                icon={Hammer} color="#10b981" label={t('adoption.hero_makers', 'Makers')} value={fInt(s.makers.total)}
                subtitle={t('adoption.hero_makers_sub', '{pct}% of members · {n} new this period', { pct: sharePct(s.makers.total, s.members.total), n: fInt(s.makers.newInPeriod) })}
            />
            <MetricCard icon={Euro} color="#f59e0b" label={t('adoption.hero_spend', 'AI spend')} value={fMoney(s.spend.cost, currency)} subtitle={spendSub} />
            <MetricCard
                icon={UserMinus} color="#94a3b8" label={t('adoption.hero_dormant', 'Dormant seats')}
                value={s.members.dormant == null ? '—' : fInt(s.members.dormant)}
                subtitle={s.members.dormant == null
                    ? t('adoption.hero_dormant_absolute', 'Needs a relative period (7, 30 or 90 days)')
                    : t('adoption.hero_dormant_sub', 'No sign-in for 30+ days · {pct}% of seats', { pct: sharePct(s.members.dormant, Math.max(seats.used, s.members.total)) })}
            />
        </MetricGrid>
    );
}

/**
 * The headline of the Adoption tab: the share of members who used AI in the
 * period, its change against the previous period, the member split and four
 * tiles (members, makers, spend, dormant seats).
 */
export default function AdoptionHero(props: AdoptionHeroProps) {
    const { t } = useTranslation();
    const { summary: s } = props;
    const rate = Math.round(s.adoptionRate);
    const delta = s.prev ? Math.round(s.adoptionRate - s.prev.adoptionRate) : null;
    const eyebrow = s.range.days != null
        ? t('adoption.hero_eyebrow_days', 'AI-active members · last {n} days', { n: s.range.days })
        : t('adoption.hero_eyebrow', 'AI-active members · this period');
    return (
        <MonitorHero
            accent="#10b981"
            eyebrow={eyebrow}
            value={`${rate}%`}
            valueColor="var(--text-primary)"
            trend={<TrendChip delta={delta} display={t('adoption.hero_pts', '{n} pts', { n: Math.abs(delta ?? 0) })} title={t('adoption.hero_vs_prev', 'Compared with the previous period')} />}
            subline={t('adoption.hero_subline', '{active} of {total} members used AI', { active: fInt(s.members.aiActive), total: fInt(s.members.total) })}
            aside={<HeroAside {...props} />}
        >
            <p className="mt-2 mb-3 text-[12px] text-[var(--text-secondary)]">{heroSentence(s, t)}</p>
            <SplitBar segments={statusSegments(s.members, t)} ariaLabel={t('adoption.hero_split_label', 'Members by activity')} />
        </MonitorHero>
    );
}
