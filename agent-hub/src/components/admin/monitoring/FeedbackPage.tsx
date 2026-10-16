import { MessageCircle, MessageSquare, Search, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PAGE_SIZE, filterFeedback, paginationBtn } from './feedback/feedbackModel';
import type { FeedbackFilter, FeedbackItem, FeedbackSummary } from './feedback/feedbackModel';
import FeedbackRow from './feedback/FeedbackRow';
import { COLORS } from './shared';
import { Card, Empty, MetricCard } from './sharedTyped';
import { useTranslation } from '../../../hooks/useTranslation';

interface FeedbackPageProps {
    feedback: FeedbackItem[];
    summary: FeedbackSummary | null | undefined;
}

function FeedbackKpis({ feedback, summary }: FeedbackPageProps) {
    const { t } = useTranslation();
    const posCount = summary?.thumbs_up || 0;
    const negCount = summary?.thumbs_down || 0;
    const total = summary?.total || 0;
    const posRate = total > 0 ? ((posCount / total) * 100).toFixed(0) : '—';
    // Count items with conversation snapshots
    const withConvoCount = useMemo(() => feedback.filter(f => f.conversation_snapshot).length, [feedback]);
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '1.25rem' }}>
            <MetricCard icon={ThumbsUp} label={t('admin_monitoring.feedback_positive', 'Positive')} color={COLORS.green}
                value={posCount} subtitle={t('admin_monitoring.feedback_approval', '{rate}% approval', { rate: posRate })} />
            <MetricCard icon={ThumbsDown} label={t('admin_monitoring.feedback_negative', 'Negative')} color={COLORS.rose}
                value={negCount} />
            <MetricCard icon={MessageCircle} label={t('admin_monitoring.feedback_with_comments', 'With Comments')} color={COLORS.purple}
                value={summary?.with_comments || 0} />
            <MetricCard icon={MessageSquare} label={t('admin_monitoring.feedback_with_convo', 'With Conversation')} color={COLORS.blue}
                value={withConvoCount} subtitle={t('admin_monitoring.feedback_shared_context', 'Shared context')} />
        </div>
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
    const filters: { id: FeedbackFilter; label: string }[] = [
        { id: 'all', label: t('admin_monitoring.feedback_f_all', 'All') },
        { id: 'positive', label: `👍 ${t('admin_monitoring.feedback_positive', 'Positive')}` },
        { id: 'negative', label: `👎 ${t('admin_monitoring.feedback_negative', 'Negative')}` },
        { id: 'comments', label: `💬 ${t('admin_monitoring.feedback_f_comments', 'Comments')}` },
        { id: 'with_convo', label: `🗨️ ${t('admin_monitoring.feedback_with_convo', 'With Conversation')}` },
    ];
    return (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap', alignItems: 'center' }}>
            {filters.map(f => (
                <button
                    key={f.id}
                    onClick={() => onFilter(f.id)}
                    style={{
                        padding: '5px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
                        border: 'none', cursor: 'pointer', transition: 'all 0.15s',
                        background: filter === f.id ? COLORS.primary + '20' : 'var(--bg-tertiary, rgba(255,255,255,0.04))',
                        color: filter === f.id ? COLORS.primary : 'var(--text-secondary, #aaa)',
                    }}
                >{f.label}</button>
            ))}
            <div style={{ flex: 1 }} />
            <div style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px',
                borderRadius: '8px', background: 'var(--bg-primary, #0f0f1a)',
                border: '1px solid var(--border-default, rgba(255,255,255,0.08))',
            }}>
                <Search style={{ width: 12, height: 12, color: 'var(--text-muted, #888)' }} />
                <input
                    value={search} onChange={e => onSearch(e.target.value)}
                    placeholder={t('admin_monitoring.feedback_search', 'Search feedback...')}
                    style={{
                        background: 'transparent', border: 'none', outline: 'none', fontSize: '12px',
                        color: 'var(--text-primary, #fff)', width: '140px',
                    }}
                />
            </div>
        </div>
    );
}

function Pagination({ pageNum, totalPages, setPageNum }: { pageNum: number; totalPages: number; setPageNum: (f: (p: number) => number) => void }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '14px', alignItems: 'center' }}>
            <button
                onClick={() => setPageNum(p => Math.max(0, p - 1))}
                disabled={pageNum === 0}
                style={paginationBtn}
            >←</button>
            <span style={{ fontSize: '12px', color: 'var(--text-muted, #888)', padding: '0 8px' }}>
                {pageNum + 1} / {totalPages}
            </span>
            <button
                onClick={() => setPageNum(p => Math.min(totalPages - 1, p + 1))}
                disabled={pageNum >= totalPages - 1}
                style={paginationBtn}
            >→</button>
        </div>
    );
}

export function FeedbackPage({ feedback, summary }: FeedbackPageProps) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState<FeedbackFilter>('all');
    const [pageNum, setPageNum] = useState(0);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [search, setSearch] = useState('');

    const filtered = useMemo(() => filterFeedback(feedback, filter, search), [feedback, filter, search]);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const paged = filtered.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);

    return (
        <div style={{ animation: 'fadeIn 0.3s ease' }}>
            <FeedbackKpis feedback={feedback} summary={summary} />

            <Card>
                <FeedbackFilterBar
                    filter={filter}
                    onFilter={(f) => { setFilter(f); setPageNum(0); }}
                    search={search}
                    onSearch={(q) => { setSearch(q); setPageNum(0); }}
                />

                {paged.length === 0 ? <Empty text={t('admin_monitoring.feedback_empty', 'No feedback entries')} /> : paged.map((item, i) => (
                    <FeedbackRow
                        key={item.id || i}
                        item={item}
                        expanded={expanded === item.id}
                        onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
                    />
                ))}

                {totalPages > 1 && <Pagination pageNum={pageNum} totalPages={totalPages} setPageNum={setPageNum} />}
            </Card>
        </div>
    );
}
