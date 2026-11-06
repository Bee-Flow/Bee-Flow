import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { RangeParams } from '@/utils/usageHelpers';
import { AlertBanner, EmptyInline } from './usage/kit';
import { FeedbackRow } from './usage/quality/FeedbackRow';
import { feedbackCounts, filterFeedback, approvalPct, type FeedbackFilter } from './usage/quality/qualityModel';
import { useFeedbackReport } from './usage/quality/qualityData';

// Trigger the action-required banner when approval drops below this threshold on a meaningful sample.
const FEEDBACK_POSITIVE_ALERT_PCT = 60;
const FEEDBACK_MIN_SAMPLE = 5;
const PAGE_SIZE = 10;
const NO_FEEDBACK_SUMMARY = { total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 };

const TH = 'px-3 pb-2.5 text-left text-[11px] font-semibold uppercase tracking-[.06em] whitespace-nowrap text-[var(--text-muted)]';

interface OrgFeedbackPanelProps {
    rangeParams: RangeParams;
    showTokens?: boolean;
}

export default function OrgFeedbackPanel({ rangeParams }: OrgFeedbackPanelProps) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState<FeedbackFilter>('all');
    const [search, setSearch] = useState('');
    const [pageNum, setPageNum] = useState(0);
    const [open, setOpen] = useState<string | null>(null);

    const report = useFeedbackReport(rangeParams);
    const loading = report.isFetching;
    const feedback = useMemo(() => report.data?.feedback ?? [], [report.data]);
    const summary = report.data?.summary ?? NO_FEEDBACK_SUMMARY;
    const counts = useMemo(() => feedbackCounts(feedback), [feedback]);
    const filtered = useMemo(() => filterFeedback(feedback, filter, search), [feedback, filter, search]);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const paged = filtered.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);

    const pct = approvalPct(summary);
    const rated = (Number(summary.thumbs_up) || 0) + (Number(summary.thumbs_down) || 0);
    const choose = (next: FeedbackFilter) => { setFilter(next); setPageNum(0); };

    const chips: { id: FeedbackFilter; label: string }[] = [
        { id: 'all', label: t('org.feedback_chip_all', 'All') },
        { id: 'positive', label: t('org.feedback_chip_positive', 'Positive') },
        { id: 'negative', label: t('org.feedback_chip_negative', 'Negative') },
        { id: 'comments', label: t('org.feedback_chip_comments', 'With comment') },
        { id: 'with_convo', label: t('org.feedback_chip_with_convo', 'Shared conversation') },
    ];

    return (
        <div className="flex flex-col gap-4">
            {pct !== null && rated >= FEEDBACK_MIN_SAMPLE && pct < FEEDBACK_POSITIVE_ALERT_PCT && (
                <AlertBanner
                    severity={pct < 40 ? 'red' : 'amber'}
                    message={t('org.feedback_alert', 'Approval is {pct}% on {n} ratings. Review the negative comments.', { pct, n: rated })}
                    ctaLabel={t('org.feedback_alert_cta', 'Review negatives')}
                    onCta={() => choose('negative')}
                />
            )}
            <section aria-label={t('org.feedback_title', 'User Feedback')} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 pb-1 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 pb-3.5 pt-2.5">
                    <div role="group" aria-label={t('org.feedback_filters', 'Feedback filters')} className="flex flex-wrap items-center gap-1">
                        {chips.map(c => (
                            <button
                                key={c.id}
                                type="button"
                                aria-pressed={filter === c.id}
                                onClick={() => choose(c.id)}
                                className={`h-[30px] cursor-pointer rounded-md border px-2.5 text-xs font-medium ${filter === c.id
                                    ? 'border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]'
                                    : 'border-transparent bg-transparent text-[var(--text-secondary)]'}`}
                            >
                                {c.label} · {counts[c.id]}
                            </button>
                        ))}
                    </div>
                    <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2.5 py-1.5">
                        <Search className="h-3 w-3 text-[var(--text-muted)]" aria-hidden="true" />
                        <input
                            type="search"
                            value={search}
                            onChange={e => { setSearch(e.target.value); setPageNum(0); }}
                            aria-label={t('org.feedback_search_label', 'Search feedback')}
                            placeholder={t('org.feedback_search_placeholder', 'Search comments')}
                            className="w-[180px] border-0 bg-transparent text-[13px] text-[var(--text-primary)] outline-none"
                        />
                    </label>
                </div>
                {paged.length === 0 ? (
                    <EmptyInline boxed text={loading ? t('org.feedback_loading', 'Loading feedback...') : t('org.feedback_empty', 'No feedback entries')} />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[900px] border-collapse">
                            <thead>
                                <tr>
                                    <th className={TH}>{t('org.feedback_col_rating', 'Rating')}</th>
                                    <th className={TH}>{t('org.feedback_col_comment', 'Comment')}</th>
                                    <th className={TH}>{t('org.feedback_col_where', 'Where')}</th>
                                    <th className={TH}>{t('org.feedback_col_model', 'Model')}</th>
                                    <th className={TH}>{t('org.feedback_col_member', 'Member')}</th>
                                    <th className={`${TH} text-right`}>{t('org.feedback_col_when', 'When')}</th>
                                    <th className={TH}><span className="sr-only">{t('org.feedback_col_conversation', 'Conversation')}</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {paged.map((item, i) => (
                                    <FeedbackRow key={item.id || i} item={item} open={open === item.id} onToggle={() => setOpen(open === item.id ? null : item.id)} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-1.5 py-3">
                        <button type="button" aria-label={t('org.feedback_prev', 'Previous page')} onClick={() => setPageNum(p => Math.max(0, p - 1))} disabled={pageNum === 0} className={PAGER}>←</button>
                        <span className="px-2 text-xs text-[var(--text-muted)]">{pageNum + 1} / {totalPages}</span>
                        <button type="button" aria-label={t('org.feedback_next', 'Next page')} onClick={() => setPageNum(p => Math.min(totalPages - 1, p + 1))} disabled={pageNum >= totalPages - 1} className={PAGER}>→</button>
                    </div>
                )}
            </section>
        </div>
    );
}

const PAGER = 'cursor-pointer rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2.5 py-1 text-xs font-semibold text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40';
