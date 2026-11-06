import { useTranslation } from '@/hooks/useTranslation';
import { fNum } from '../format';
import { SegmentBar } from '../shell';
import { typeMeta } from './terminationMeta';
import { approvalPct, typeCounts, type FeedbackSummaryCounts } from './qualityModel';
import type { TerminationsByType } from '@/pages/settings/OrgTerminationsPanel.types';

const CARD = 'flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-6';
const LABEL = 'm-0 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]';
const BIG = 'text-[40px] font-semibold leading-none tracking-[-.03em] text-[var(--text-primary)]';

export interface ApprovalCardProps {
    summary: FeedbackSummaryCounts;
    /** All AI calls in the range; the coverage sentence is left out without it. */
    totalCalls?: number;
}

export function ApprovalCard({ summary, totalCalls }: ApprovalCardProps) {
    const { t } = useTranslation();
    const up = Number(summary.thumbs_up) || 0;
    const down = Number(summary.thumbs_down) || 0;
    const pct = approvalPct(summary);
    const coverage = totalCalls && totalCalls > 0 ? Math.round(((up + down) / totalCalls) * 1000) / 10 : null;
    return (
        <article className={CARD} aria-label={t('org.quality_approval_label', 'Approval · answers people rated')}>
            <p className={LABEL}>{t('org.quality_approval_label', 'Approval · answers people rated')}</p>
            <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
                <span className={BIG}>{pct === null ? '—' : `${pct}%`}</span>
                <span className="text-[13px] text-[var(--text-muted)]">
                    {pct === null
                        ? t('org.quality_approval_none', 'No ratings in this period')
                        : t('org.quality_approval_meta', '{total} ratings · {up} up, {down} down · {comments} with a comment', {
                            total: fNum(up + down), up: fNum(up), down: fNum(down), comments: fNum(Number(summary.with_comments) || 0),
                        })}
                </span>
            </div>
            <SegmentBar
                height={10}
                segments={[
                    { value: up, color: 'var(--text-primary)', label: t('org.feedback_positive', 'Positive') },
                    { value: down, color: 'var(--warning)', label: t('org.feedback_negative', 'Negative') },
                ]}
            />
            {coverage !== null && totalCalls !== undefined && (
                <p className="m-0 text-[13px] text-[var(--text-secondary)]">
                    {t('org.quality_approval_coverage', 'Ratings cover {pct}% of the {calls} calls.', { pct: coverage, calls: fNum(totalCalls) })}
                </p>
            )}
        </article>
    );
}

export interface TerminationsCardProps {
    total: number;
    byType: TerminationsByType | undefined;
    largeInput: number;
    totalCalls?: number;
}

const TYPES = ['max_tokens', 'max_iterations', 'error', 'aborted'] as const;

export function TerminationsCard({ total, byType, largeInput, totalCalls }: TerminationsCardProps) {
    const { t } = useTranslation();
    const counts = typeCounts(byType);
    const labelOf = (type: string) => t(`org.terminations_type_${type}`, type);
    const parts: string[] = [];
    if (totalCalls && totalCalls > 0) {
        parts.push(t('org.quality_term_share', '{pct}% of calls', { pct: Math.round((total / totalCalls) * 1000) / 10 }));
    }
    parts.push(t('org.quality_term_large', '{n} likely caused by a large input', { n: fNum(largeInput) }));
    return (
        <article className={CARD} aria-label={t('org.quality_term_label', 'Terminations · tasks that ended early')}>
            <p className={LABEL}>{t('org.quality_term_label', 'Terminations · tasks that ended early')}</p>
            <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
                <span className={BIG}>{fNum(total)}</span>
                <span className="text-[13px] text-[var(--text-muted)]">{parts.join(' · ')}</span>
            </div>
            <SegmentBar height={10} segments={TYPES.map(type => ({ value: counts[type], color: typeMeta(type).color, label: labelOf(type) }))} />
            <ul className="m-0 flex list-none flex-wrap gap-x-[18px] gap-y-2 p-0 text-xs text-[var(--text-secondary)]">
                {TYPES.map(type => (
                    <li key={type} className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[3px]" ref={el => el?.style.setProperty('background-color', typeMeta(type).color)} />
                        {labelOf(type)} {counts[type]}
                    </li>
                ))}
            </ul>
        </article>
    );
}
