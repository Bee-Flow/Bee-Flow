import { Download, RefreshCw, Table2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { defaultRange } from './answersRange';
import QuestionCard from './QuestionCard';
import RangeBar from './RangeBar';
import ResponseDrawer from './ResponseDrawer';
import useAnswersSummary from './useAnswersSummary';
import useRelativeTime from '../../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { formatDate } from '../../../../../utils/dateFormatters';
import TokenBarChart from '../../../../shared/charts/TokenBarChart';
import DashCard from '../../../../shared/dashboard/DashCard';
import DashSkeleton from '../../../../shared/dashboard/DashSkeleton';
import StatGrid from '../../../../shared/dashboard/StatGrid';
import StatTile from '../../../../shared/dashboard/StatTile';
import Disclosure from '../../../../shared/Disclosure';
import EmptyState from '../../../../shared/EmptyState';
import { toast } from '../../../../shared/Toast';
import { datatablesApi } from '../../Datatables/datatablesApi';
import RowBrowser from '../../Datatables/RowBrowser';

const BTN = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50';

function bucketLabel(bucket, kind) {
    const s = String(bucket || '');
    if (kind === 'month') {
        const m = /^(\d{4})-(\d{2})/.exec(s);
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : s;
    }
    const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
    if (Number.isNaN(d.getTime())) return s;
    return kind === 'week' ? `wk ${formatDate(d, { locale: undefined }).replace(/\s\d{4}$/, '')}` : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * The answers dashboard: a period, four numbers, responses over time, one
 * card per question, the recent responses (each opening a drawer), and the
 * full responses table with its export. Used by the Form page and by the
 * answers table's Dashboard tab alike.
 */
export default function AnswersDashboard({ datatableId, grade = null, mine = false, automationId = null, onNavigate = null, onCopyLink = null, testId = 'answers-dashboard' }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [range, setRange] = useState(defaultRange);
    const { data, loading, refreshing, error, updatedAt, reload } = useAnswersSummary(datatableId, range);
    const [open, setOpen] = useState(null);
    const [focus, setFocus] = useState(null);
    const [exporting, setExporting] = useState(false);

    const questions = useMemo(() => (Array.isArray(data?.questions) ? data.questions : []), [data]);
    const live = useMemo(() => questions.filter(q => !q.retired), [questions]);
    const retired = useMemo(() => questions.filter(q => q.retired), [questions]);
    const totals = data?.totals || null;
    const multiPage = !!(data && (totals?.open > 0 || questions.some(q => q.pageStepId)));

    const exportCsv = async () => {
        setExporting(true);
        try {
            const text = await datatablesApi.exportCsv(datatableId);
            const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${(data?.table?.name || 'answers').replace(/[^\w.-]+/g, '_')}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) {
            toast.error(e?.message || t('forms.answers.export_failed', 'Could not export the responses.'));
        } finally {
            setExporting(false);
        }
    };

    if (loading && !data) return <DashSkeleton tiles={4} cards={3} testId={`${testId}-skeleton`} />;
    if (error && !data) {
        return (
            <div className="rounded-xl border p-4 text-xs" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-card)', color: 'var(--error)' }} role="alert">
                {t('forms.answers.load_failed', 'Could not load the answers.')}{' '}
                <button type="button" onClick={reload} className="underline">{t('forms.answers.retry', 'Try again')}</button>
            </div>
        );
    }
    if (!data) return null;

    const seeAll = (q) => setFocus(q ? [{ field: q.key, op: 'isNotNull' }] : null);
    const lastResponse = totals?.lastAt ? rel(totals.lastAt) : t('forms.answers.kpi_never', 'None yet');
    const updatedLabel = updatedAt ? t('forms.answers.updated', 'Updated {when}', { when: rel(updatedAt) }) : null;

    return (
        <div className="space-y-4" data-testid={testId} aria-label={t('forms.answers.label', 'Answers dashboard')}>
            <RangeBar range={range} onChange={setRange} updatedLabel={updatedLabel} />

            {totals && totals.all === 0 ? (
                <EmptyState
                    illustration="EmptyInbox"
                    title={t('forms.answers.empty_title', 'No responses yet')}
                    description={t('forms.answers.empty_body', 'Share the link — the first answer shows up here the moment it is submitted.')}
                    action={onCopyLink ? { label: t('forms.answers.empty_cta', 'Copy the link'), onClick: onCopyLink } : undefined}
                />
            ) : (
                <>
                    <StatGrid testId="answers-kpis">
                        <StatTile label={t('forms.answers.kpi_in_range', 'Responses in this period')} value={totals.inRange} testId="kpi-in-range" />
                        <StatTile label={t('forms.answers.kpi_all', 'All time')} value={totals.all} testId="kpi-all" />
                        <StatTile label={t('forms.answers.kpi_today', 'Today')} value={totals.today} testId="kpi-today" />
                        {multiPage
                            ? <StatTile label={t('forms.answers.kpi_completion', 'Completed all pages')} value={totals.inRange ? `${Math.round((totals.completed / totals.inRange) * 100)}%` : '—'} hint={`${totals.completed} / ${totals.inRange}`} testId="kpi-completion" />
                            : <StatTile label={t('forms.answers.kpi_last', 'Last response')} value={lastResponse} testId="kpi-last" />}
                    </StatGrid>

                    <DashCard
                        title={t('forms.answers.timeline_title', 'Responses over time')}
                        meta={{ day: t('forms.answers.timeline_day', 'per day'), week: t('forms.answers.timeline_week', 'per week'), month: t('forms.answers.timeline_month', 'per month') }[data.range?.bucket] || null}
                        action={<button type="button" onClick={reload} disabled={refreshing} className={BTN} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} aria-label={t('forms.answers.refresh', 'Refresh')}><RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /></button>}
                        testId="answers-timeline"
                    >
                        {data.timeline?.length ? (
                            <TokenBarChart
                                data={data.timeline.map(b => ({ x: b.bucket, n: b.n, label: bucketLabel(b.bucket, data.range?.bucket) }))}
                                ariaLabel={t('forms.answers.timeline_title', 'Responses over time')}
                                xTickFormatter={(x) => bucketLabel(x, data.range?.bucket)}
                            />
                        ) : (
                            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('forms.answers.q_none', 'No answers in this period.')}</p>
                        )}
                    </DashCard>

                    {live.map((q) => <QuestionCard key={q.fieldId} t={t} q={q} onSeeAll={seeAll} />)}

                    {retired.length > 0 && (
                        <Disclosure title={`${t('forms.answers.retired_title', 'No longer on the form')} (${retired.length})`} hint={t('forms.answers.retired_hint', 'Questions removed from the form. Their answers are still in the table.')} variant="card">
                            <div className="space-y-3 pt-2" data-testid="answers-retired">
                                {retired.map((q) => <QuestionCard key={q.fieldId} t={t} q={q} onSeeAll={seeAll} />)}
                            </div>
                        </Disclosure>
                    )}

                    <DashCard title={t('forms.answers.recent_title', 'Recent responses')} testId="answers-recent">
                        <ul role="list" className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                            {(data.recent || []).map((r) => {
                                const when = r.submittedAt ? rel(r.submittedAt) : '';
                                const who = r.by?.name || (r.by ? r.by.id : t('forms.answers.anonymous', 'Anonymous'));
                                const preview = Object.values(r.preview || {}).filter(v => v !== null && v !== undefined && v !== '').map(String).slice(0, 3).join(' · ');
                                return (
                                    <li key={r.rowId}>
                                        <button type="button" onClick={() => setOpen(r)} className="w-full text-left flex items-center gap-3 py-2 text-xs hover:bg-[var(--bg-secondary)] rounded-lg px-1" aria-label={t('forms.answers.recent_open', 'Open the response from {when}', { when })} data-testid="recent-row">
                                            <span className="shrink-0 w-20 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{when}</span>
                                            <span className="shrink-0 w-32 truncate" style={{ color: 'var(--text-primary)' }}>{who}</span>
                                            <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>{preview}</span>
                                            <span aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>›</span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </DashCard>
                </>
            )}

            <DashCard
                title={t('forms.answers.all_title', 'All responses')}
                action={(
                    <>
                        <button type="button" onClick={exportCsv} disabled={exporting} className={BTN} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} data-testid="answers-export">
                            <Download className="w-3 h-3" aria-hidden="true" />{t('forms.answers.all_export', 'Export (CSV)')}
                        </button>
                        <button type="button" onClick={() => onNavigate && onNavigate(`studio/datatables/${datatableId}`)} className={BTN} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} data-testid="answers-open-table">
                            <Table2 className="w-3 h-3" aria-hidden="true" />{t('forms.answers.all_open_table', 'Open the table')}
                        </button>
                    </>
                )}
                testId="answers-all"
            >
                {focus && (
                    <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
                        {t('forms.answers.all_filtered', 'Showing the responses that answered “{label}”.', { label: questions.find(q => q.key === focus[0].field)?.label || focus[0].field })}{' '}
                        <button type="button" onClick={() => setFocus(null)} className="underline">{t('forms.answers.all_clear', 'Show every response')}</button>
                    </p>
                )}
                <RowBrowser key={focus ? focus[0].field : 'all'} table={{ id: datatableId, name: data.table?.name, grade: grade || 'viewer', rowCount: data.table?.rowCount, managedKind: 'form_answers' }} initialFilters={focus} reloadKey={updatedAt ? updatedAt.getTime() : null} />
            </DashCard>

            {open && (
                <ResponseDrawer datatableId={datatableId} response={open} questions={questions} mine={mine} automationId={automationId} onNavigate={onNavigate} onClose={() => setOpen(null)} />
            )}
        </div>
    );
}
