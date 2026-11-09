import { useMemo, useState } from 'react';
import StatGrid from '@/components/shared/dashboard/StatGrid';
import FilterPills from '@/components/shared/FilterPills';
import Pager from '@/components/shared/Pager';
import { PAGE_SIZE, filterFeedback } from './feedback/feedbackModel';
import type { FeedbackFilter, FeedbackItem, FeedbackSummary } from './feedback/feedbackModel';
import FeedbackRow from './feedback/FeedbackRow';
import { Empty, MetricTile } from './sharedTyped';
import { SearchField } from './shared/FilterControls';
import { useTranslation } from '@/hooks/useTranslation';

interface FeedbackPageProps {
    feedback: FeedbackItem[];
    summary: FeedbackSummary | null | undefined;
}

function FeedbackKpis({ feedback, summary }: FeedbackPageProps) {
    const { t } = useTranslation();
    const posCount = summary?.thumbs_up || 0;
    const total = summary?.total || 0;
    const posRate = total > 0 ? ((posCount / total) * 100).toFixed(0) : '—';
    // Count items with conversation snapshots
    const withConvoCount = useMemo(() => feedback.filter(f => f.conversation_snapshot).length, [feedback]);
    return (
        <StatGrid>
            <MetricTile label={t('admin_monitoring.feedback_positive', 'Positive')} value={posCount} subtitle={t('admin_monitoring.feedback_approval', '{rate}% approval', { rate: posRate })} />
            <MetricTile label={t('admin_monitoring.feedback_negative', 'Negative')} value={summary?.thumbs_down || 0} />
            <MetricTile label={t('admin_monitoring.feedback_with_comments', 'With Comments')} value={summary?.with_comments || 0} />
            <MetricTile label={t('admin_monitoring.feedback_with_convo', 'With Conversation')} value={withConvoCount} subtitle={t('admin_monitoring.feedback_shared_context', 'Shared context')} />
        </StatGrid>
    );
}

interface FilterBarProps {
    filter: FeedbackFilter;
    onFilter: (f: FeedbackFilter) => void;
    search: string;
    onSearch: (q: string) => void;
}

function FeedbackFilterBar({ filter, onFilter, search, onSearch }: FilterBarProps) {
    const { t } = useTranslation();
    const options: { value: FeedbackFilter; label: string }[] = [
        { value: 'all', label: t('admin_monitoring.feedback_f_all', 'All') },
        { value: 'positive', label: t('admin_monitoring.feedback_positive', 'Positive') },
        { value: 'negative', label: t('admin_monitoring.feedback_negative', 'Negative') },
        { value: 'comments', label: t('admin_monitoring.feedback_f_comments', 'Comments') },
        { value: 'with_convo', label: t('admin_monitoring.feedback_with_convo', 'With Conversation') },
    ];
    return (
        <div className="flex flex-wrap items-center gap-2">
            <FilterPills value={filter} onChange={onFilter} options={options} ariaLabel={t('admin_monitoring.shared_filters', 'Filters')} />
            <SearchField value={search} onChange={onSearch} placeholder={t('admin_monitoring.feedback_search', 'Search feedback...')} className="w-full sm:ml-auto sm:w-56" />
        </div>
    );
}

export function FeedbackPage({ feedback, summary }: FeedbackPageProps) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState<FeedbackFilter>('all');
    const [offset, setOffset] = useState(0);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [search, setSearch] = useState('');

    const filtered = useMemo(() => filterFeedback(feedback, filter, search), [feedback, filter, search]);
    // The list can shrink under the reader (a shorter range, the minute refresh):
    // a page past the end would read as "no entries" while there are some.
    const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1) * PAGE_SIZE;
    const currentOffset = Math.min(offset, lastPage);
    const paged = filtered.slice(currentOffset, currentOffset + PAGE_SIZE);

    return (
        <div className="flex flex-col gap-4">
            <FeedbackKpis feedback={feedback} summary={summary} />
            <FeedbackFilterBar
                filter={filter}
                onFilter={(f) => { setFilter(f); setOffset(0); }}
                search={search}
                onSearch={(q) => { setSearch(q); setOffset(0); }}
            />
            {paged.length === 0 ? <Empty text={t('admin_monitoring.feedback_empty', 'No feedback entries')} /> : (
                <section aria-label={t('admin.mon_feedback')} className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)]">
                    {paged.map((item, i) => (
                        <FeedbackRow
                            key={item.id || i}
                            item={item}
                            expanded={expanded === item.id}
                            onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
                        />
                    ))}
                    {filtered.length > PAGE_SIZE && <Pager offset={currentOffset} limit={PAGE_SIZE} total={filtered.length} onOffset={setOffset} />}
                </section>
            )}
        </div>
    );
}
