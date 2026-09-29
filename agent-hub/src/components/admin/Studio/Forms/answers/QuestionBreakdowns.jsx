import React from 'react';
import useRelativeTime from '../../../../../hooks/useRelativeTime';
import { formatDate } from '../../../../../utils/dateFormatters';
import BarList from '../../../../shared/charts/BarList';
import SplitBar from '../../../../shared/charts/SplitBar';
import TokenBarChart from '../../../../shared/charts/TokenBarChart';

const fmt = new Intl.NumberFormat();

function monthLabel(bucket) {
    // the server's month bucket is 'YYYY-MM' (to_char); a day is 'YYYY-MM-DD'
    const m = /^(\d{4})-(\d{2})/.exec(String(bucket || ''));
    if (!m) return String(bucket);
    return formatDate(new Date(Number(m[1]), Number(m[2]) - 1, 1), { locale: undefined }).replace(/^\d+\s/, '');
}

export function ChoiceBreakdown({ t, q }) {
    const values = q.breakdown?.values || [];
    if (!values.length) return <NoAnswers t={t} />;
    return <BarList rows={values.map(v => ({ label: v.value, n: v.n, pct: v.pct }))} ariaLabel={q.label} moreLabel={(n) => t('forms.answers.q_more', '{n} more', { n })} testId="q-choice" />;
}

export function YesNoBreakdown({ t, q }) {
    const b = q.breakdown || { yes: 0, no: 0 };
    if (!b.yes && !b.no) return <NoAnswers t={t} />;
    return <SplitBar segments={[{ label: t('forms.answers.q_yes', 'Yes'), n: b.yes }, { label: t('forms.answers.q_no', 'No'), n: b.no }]} ariaLabel={q.label} testId="q-yesno" />;
}

export function NumberBreakdown({ t, q }) {
    const b = q.breakdown || {};
    if (b.avg === null || b.avg === undefined) return <NoAnswers t={t} />;
    const cell = (label, v) => (
        <div key={label} className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-secondary)' }}>
            <div className="text-base font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{v === null || v === undefined ? '—' : fmt.format(v)}</div>
            <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
        </div>
    );
    return (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="q-number" aria-label={q.label}>
            {cell(t('forms.answers.q_avg', 'Average'), b.avg)}
            {cell(t('forms.answers.q_median', 'Median'), b.p50)}
            {cell(t('forms.answers.q_min', 'Lowest'), b.min)}
            {cell(t('forms.answers.q_max', 'Highest'), b.max)}
        </div>
    );
}

export function DateBreakdown({ t, q }) {
    const buckets = q.breakdown?.buckets || [];
    if (!buckets.length) return <NoAnswers t={t} />;
    return <TokenBarChart data={buckets.map(b => ({ x: b.bucket, n: b.n, label: monthLabel(b.bucket) }))} height={140} ariaLabel={q.label} xTickFormatter={monthLabel} seriesIndex={2} testId="q-date" />;
}

export function TextBreakdown({ t, q, onSeeAll }) {
    const rel = useRelativeTime();
    const recent = (q.breakdown?.recent || []).slice(0, 5);
    if (!recent.length) return <NoAnswers t={t} />;
    return (
        <div data-testid="q-text">
            <ul role="list" aria-label={t('forms.answers.q_recent', 'Most recent answers')} className="space-y-2">
                {recent.map((r) => (
                    <li key={r.rowId} className="flex items-start gap-3 text-xs">
                        <span className="flex-1 min-w-0 whitespace-pre-wrap break-words" style={{ color: 'var(--text-primary)' }}>“{r.value}”</span>
                        <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{r.at ? rel(r.at) : ''}</span>
                    </li>
                ))}
            </ul>
            {onSeeAll && (
                <button type="button" onClick={onSeeAll} className="mt-2 text-xs underline-offset-2 hover:underline" style={{ color: 'var(--text-secondary)' }}>
                    {t('forms.answers.q_see_all', 'See all answers')} →
                </button>
            )}
        </div>
    );
}

export function FileBreakdown({ t, q, onSeeAll }) {
    const n = q.breakdown?.count || 0;
    return (
        <div className="flex items-center gap-3 text-xs" data-testid="q-file">
            <span style={{ color: 'var(--text-primary)' }}>
                {n === 1 ? t('forms.answers.q_files', '{count} file', { count: n }) : t('forms.answers.q_files_plural', '{count} files', { count: n })}
            </span>
            {onSeeAll && n > 0 && (
                <button type="button" onClick={onSeeAll} className="underline-offset-2 hover:underline" style={{ color: 'var(--text-secondary)' }}>
                    {t('forms.answers.q_files_open', 'Open the rows')} →
                </button>
            )}
        </div>
    );
}

export function NoAnswers({ t }) {
    return <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('forms.answers.q_none', 'No answers in this period.')}</p>;
}

/** The breakdown a question gets, by its type. */
export function breakdownFor(q) {
    switch (q.breakdown?.kind) {
        case 'choice': return ChoiceBreakdown;
        case 'yesno': return YesNoBreakdown;
        case 'number': return NumberBreakdown;
        case 'date': return DateBreakdown;
        case 'file': return FileBreakdown;
        case 'text': return TextBreakdown;
        default: return NoAnswers;
    }
}
