import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { DeltaPill, MoreLink, SegmentBar, Swatch, type Segment } from '../shell';
import type { AdoptionSummary } from './adoption.types';
import { fInt, fMoney, sharePct } from './format';

interface AdoptionHeroProps {
    summary: AdoptionSummary;
    currency: string;
    showCalls: boolean;
    /** Page-wide compare switch: off hides the change against the previous period. */
    compare?: boolean;
    /** Switches to the Areas view ("Where the AI goes"). */
    onOpenAreas?: () => void;
}

type T = ReturnType<typeof useTranslation>['t'];

/** The member split for the bar and its legend; seen/dormant/never exist only for a relative period. */
function statusSegments(m: AdoptionSummary['members'], t: T): Segment[] {
    const segs: Segment[] = [{ label: t('adoption.hero_seg_active', 'AI-active'), value: m.aiActive, color: 'var(--accent-primary)' }];
    if (m.seenOnly != null) segs.push({ label: t('adoption.hero_seg_seen', 'Signed in only'), value: m.seenOnly, color: 'var(--text-muted)' });
    if (m.dormant != null) segs.push({ label: t('adoption.hero_seg_dormant', 'Dormant > 30 d'), value: m.dormant, color: 'var(--warning)' });
    if (m.never != null) segs.push({ label: t('adoption.hero_seg_never', 'Never signed in'), value: m.never, color: 'var(--border-subtle)' });
    return segs;
}

function Legend({ segments, t }: { segments: Segment[]; t: T }) {
    return (
        <ul aria-label={t('adoption.hero_split_label', 'Members by activity')} className="m-0 flex list-none flex-wrap gap-x-[18px] gap-y-2 p-0 text-xs text-[var(--text-secondary)]">
            {segments.map(s => (
                <li key={s.label} className="inline-flex items-center gap-1.5">
                    <Swatch color={s.color} className="h-2.5 w-2.5 rounded-[3px] border border-[var(--border-subtle)]" />
                    {s.label} <span className="font-semibold tabular-nums text-[var(--text-primary)]">{fInt(s.value)}</span>
                </li>
            ))}
        </ul>
    );
}

function Fact({ label, value, sub, children }: { label: string; value: string; sub: string; children?: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1.5 border-l border-[var(--border-subtle)] pl-4">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{label}</p>
            <span className="text-2xl font-semibold leading-none tracking-[-.02em] text-[var(--text-primary)]">{value}</span>
            <span className="text-xs text-[var(--text-muted)]">{sub}</span>
            {children}
        </div>
    );
}

function Facts({ summary: s, currency, showCalls, compare, onOpenAreas }: AdoptionHeroProps) {
    const { t } = useTranslation();
    const seats = s.members.seats;
    const seatLine = seats.max != null
        ? t('adoption.hero_members_sub', '+{n} joined · {max} seats licensed', { n: fInt(s.members.newInPeriod), max: fInt(seats.max) })
        : t('adoption.hero_members_sub_nomax', '+{n} joined this period', { n: fInt(s.members.newInPeriod) });
    const costDelta = compare && s.prev && s.prev.cost > 0 ? Math.round(((s.spend.cost - s.prev.cost) / s.prev.cost) * 100) : null;
    const spendSub = [
        costDelta != null ? t('adoption.hero_spend_delta', '{delta} vs previous period', { delta: `${costDelta > 0 ? '+' : ''}${costDelta}%` }) : null,
        t('adoption.hero_spend_per', '{cost} per active member', { cost: fMoney(s.spend.perActiveMember, currency) }),
        showCalls && s.spend.calls != null ? t('adoption.hero_spend_calls', '{n} calls', { n: fInt(s.spend.calls) }) : null,
    ].filter(Boolean).join(' · ');
    return (
        <div className="grid content-start gap-4 [grid-template-columns:repeat(3,minmax(0,1fr))]">
            <Fact label={t('adoption.hero_members', 'Members')} value={fInt(s.members.total)} sub={seatLine} />
            <Fact
                label={t('adoption.hero_makers', 'Makers')} value={fInt(s.makers.total)}
                sub={t('adoption.hero_makers_sub', '{pct}% of members · {n} new this period', { pct: sharePct(s.makers.total, s.members.total), n: fInt(s.makers.newInPeriod) })}
            />
            <Fact label={t('adoption.hero_spend', 'AI spend')} value={fMoney(s.spend.cost, currency)} sub={spendSub}>
                {onOpenAreas && <MoreLink label={t('adoption.hero_spend_more', 'Where the AI goes')} onClick={onOpenAreas} />}
            </Fact>
        </div>
    );
}

/**
 * The headline of the Adoption tab: the share of members who used AI in the
 * period with its change against the previous period, the member split as one
 * bar with a legend, and three facts (members, makers, AI spend).
 */
export default function AdoptionHero(props: AdoptionHeroProps) {
    const { t } = useTranslation();
    const { summary: s, compare = true } = props;
    const delta = s.prev ? Math.round(s.adoptionRate - s.prev.adoptionRate) : null;
    const segments = statusSegments(s.members, t);
    const eyebrow = s.range.days != null
        ? t('adoption.hero_eyebrow_days', 'AI-active members · last {n} days', { n: s.range.days })
        : t('adoption.hero_eyebrow', 'AI-active members · this period');
    return (
        <section aria-label={t('adoption.hero_label', 'Adoption summary')} className="grid gap-x-10 gap-y-6 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-6 [grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr))]">
            <div className="flex min-w-0 flex-col gap-3">
                <p className="m-0 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{eyebrow}</p>
                <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
                    <span className="text-5xl font-semibold leading-none tracking-[-.03em] text-[var(--text-primary)]">{`${Math.round(s.adoptionRate)}%`}</span>
                    <DeltaPill delta={delta} unit="pts" compare={compare} />
                </div>
                <p className="m-0 text-[13px] text-[var(--text-secondary)]">
                    {t('adoption.hero_subline', '{active} of {total} members used AI', { active: fInt(s.members.aiActive), total: fInt(s.members.total) })}
                </p>
                <SegmentBar segments={segments} height={12} />
                <Legend segments={segments} t={t} />
                {s.members.seenOnly == null && (
                    <p className="m-0 text-xs text-[var(--text-muted)]">{t('adoption.hero_dormant_absolute', 'Needs a relative period (7, 30 or 90 days)')}</p>
                )}
            </div>
            <Facts {...props} compare={compare} />
        </section>
    );
}
