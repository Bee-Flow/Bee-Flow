import useRelativeTime from '@/hooks/useRelativeTime';
import { formatDate } from '@/utils/dateFormatters';
import BarList from '@/components/shared/charts/BarList';
import SplitBar from '@/components/shared/charts/SplitBar';
import TokenBarChart from '@/components/shared/charts/TokenBarChart';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AnswersQuestion } from './useAnswersSummary';

const fmt = new Intl.NumberFormat();

function monthLabel(bucket: string) {
    // the server's month bucket is 'YYYY-MM' (to_char); a day is 'YYYY-MM-DD'
    const m = /^(\d{4})-(\d{2})/.exec(String(bucket || ''));
    if (!m) return String(bucket);
    return formatDate(new Date(Number(m[1]), Number(m[2]) - 1, 1), { locale: undefined }).replace(/^\d+\s/, '');
}

interface ChoiceBreakdownProps {
    t: TranslateFn;
    q: AnswersQuestion;
}

function ChoiceBreakdown({ t, q }: ChoiceBreakdownProps) {
    const values = q.breakdown?.values || [];
    if (!values.length) return <NoAnswers t={t} />;
    return <BarList rows={values.map(v => ({ label: v.value, n: v.n, pct: v.pct }))} ariaLabel={q.label} moreLabel={(n) => t('forms.answers.q_more', '{n} more', { n })} testId="q-choice" />;
}

interface YesNoBreakdownProps {
    t: TranslateFn;
    q: AnswersQuestion;
}

function YesNoBreakdown({ t, q }: YesNoBreakdownProps) {
    const b = q.breakdown || { yes: 0, no: 0 };
    if (!b.yes && !b.no) return <NoAnswers t={t} />;
    return <SplitBar segments={[{ label: t('forms.answers.q_yes', 'Yes'), n: Number(b.yes) }, { label: t('forms.answers.q_no', 'No'), n: Number(b.no) }]} ariaLabel={q.label} testId="q-yesno" />;
}

interface NumberBreakdownProps {
    t: TranslateFn;
    q: AnswersQuestion;
}

function NumberBreakdown({ t, q }: NumberBreakdownProps) {
    const b = q.breakdown || {};
    if (b.avg === null || b.avg === undefined) return <NoAnswers t={t} />;
    const cell = (label: string | number | bigint | null, v: number | null | undefined) => (
        <div key={label} className="rounded-lg px-3 py-2 bg-[var(--bg-secondary)]">
            <div className="text-base font-semibold tabular-nums text-[var(--text-primary)]">{v === null || v === undefined ? '—' : fmt.format(v)}</div>
            <div className="text-[11px] text-[var(--text-tertiary)]">{label}</div>
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

interface DateBreakdownProps {
    t: TranslateFn;
    q: AnswersQuestion;
}

function DateBreakdown({ t, q }: DateBreakdownProps) {
    const buckets = q.breakdown?.buckets || [];
    if (!buckets.length) return <NoAnswers t={t} />;
    return <TokenBarChart data={buckets.map(b => ({ x: b.bucket, n: b.n, label: monthLabel(b.bucket) }))} height={140} ariaLabel={q.label} xTickFormatter={monthLabel} seriesIndex={2} testId="q-date" />;
}

interface TextBreakdownProps {
    t: TranslateFn;
    q: AnswersQuestion;
    onSeeAll: (() => void) | null;
}

function TextBreakdown({ t, q, onSeeAll }: TextBreakdownProps) {
    const rel = useRelativeTime();
    const recent = (q.breakdown?.recent || []).slice(0, 5);
    if (!recent.length) return <NoAnswers t={t} />;
    return (
        <div data-testid="q-text">
            <ul role="list" aria-label={t('forms.answers.q_recent', 'Most recent answers')} className="space-y-2">
                {recent.map((r) => (
                    <li key={r.rowId} className="flex items-start gap-3 text-xs">
                        <span className="flex-1 min-w-0 whitespace-pre-wrap break-words text-[var(--text-primary)]">“{r.value}”</span>
                        <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">{r.at ? rel(r.at) : ''}</span>
                    </li>
                ))}
            </ul>
            {onSeeAll && (
                <button type="button" onClick={onSeeAll} className="mt-2 text-xs underline-offset-2 hover:underline text-[var(--text-secondary)]">
                    {t('forms.answers.q_see_all', 'See all answers')} →
                </button>
            )}
        </div>
    );
}

interface FileBreakdownProps {
    t: TranslateFn;
    q: AnswersQuestion;
    onSeeAll: (() => void) | null;
}

function FileBreakdown({ t, q, onSeeAll }: FileBreakdownProps) {
    const n = q.breakdown?.count || 0;
    return (
        <div className="flex items-center gap-3 text-xs" data-testid="q-file">
            <span className="text-[var(--text-primary)]">
                {n === 1 ? t('forms.answers.q_files', '{count} file', { count: n }) : t('forms.answers.q_files_plural', '{count} files', { count: n })}
            </span>
            {onSeeAll && n > 0 && (
                <button type="button" onClick={onSeeAll} className="underline-offset-2 hover:underline text-[var(--text-secondary)]">
                    {t('forms.answers.q_files_open', 'Open the rows')} →
                </button>
            )}
        </div>
    );
}

function NoAnswers({ t }: { t: TranslateFn }) {
    return <p className="text-xs text-[var(--text-tertiary)]">{t('forms.answers.q_none', 'No answers in this period.')}</p>;
}

/** The breakdown a question gets, by its type. */
/** The breakdown a question's type earns; each branch names its component, none is picked at render. */
export function QuestionBreakdown({ t, q, onSeeAll }: { t: TranslateFn; q: AnswersQuestion; onSeeAll: (() => void) | null }) {
    switch (q.breakdown?.kind) {
        case 'choice': return <ChoiceBreakdown t={t} q={q} />;
        case 'yesno': return <YesNoBreakdown t={t} q={q} />;
        case 'number': return <NumberBreakdown t={t} q={q} />;
        case 'date': return <DateBreakdown t={t} q={q} />;
        case 'file': return <FileBreakdown t={t} q={q} onSeeAll={onSeeAll} />;
        case 'text': return <TextBreakdown t={t} q={q} onSeeAll={onSeeAll} />;
        default: return <NoAnswers t={t} />;
    }
}
