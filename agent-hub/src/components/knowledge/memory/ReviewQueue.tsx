import { Check, X } from 'lucide-react';
import React from 'react';

import { useTranslation } from '../../../hooks/useTranslation';
import EmptyState from '../../shared/EmptyState';
import Spinner from '../../shared/Spinner';
import MemoryRow from './MemoryRow';
import type { Memory } from './memoryTypes';

interface ReviewQueueProps {
    items: Memory[];
    total: number;
    hasMore: boolean;
    loadingMore: boolean;
    onApprove: (id: string) => void;
    onReject: (id: string) => void;
    onLoadMore: () => void;
}

/** Memories about sensitive topics wait here until the person says keep or drop. */
export default function ReviewQueue({ items, total, hasMore, loadingMore, onApprove, onReject, onLoadMore }: ReviewQueueProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-3">
            <p className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                {t('knowledge.memory_review_explainer', 'These memories touch sensitive topics, which you chose to allow. Nothing here is used in your chats until you approve it. Rejecting deletes it.')}
            </p>
            {items.length === 0 ? (
                <EmptyState
                    title={t('knowledge.memory_review_empty', 'Nothing to review')}
                    description={t('knowledge.memory_review_empty_desc', 'When the assistant picks up something sensitive, it waits here for your decision.')}
                />
            ) : (
                <ul className="space-y-2" aria-label={t('knowledge.memory_review_list_label', 'Memories to review')}>
                    {items.map((m) => (
                        <MemoryRow
                            key={m.id}
                            memory={m}
                            canWrite={false}
                            actions={(
                                <div className="flex flex-shrink-0 items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => onApprove(m.id)}
                                        className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent-primary)] px-2.5 py-1 text-xs font-semibold text-white"
                                    >
                                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                        {t('knowledge.memory_approve', 'Approve')}
                                        <span className="sr-only">{`: ${m.content.slice(0, 40)}`}</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onReject(m.id)}
                                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-xs font-medium text-rose-500 hover:bg-rose-500/10"
                                    >
                                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                                        {t('knowledge.memory_reject', 'Reject')}
                                        <span className="sr-only">{`: ${m.content.slice(0, 40)}`}</span>
                                    </button>
                                </div>
                            )}
                        />
                    ))}
                </ul>
            )}
            {hasMore && (
                <div className="flex justify-center">
                    <button
                        type="button"
                        onClick={onLoadMore}
                        disabled={loadingMore}
                        className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] disabled:opacity-50"
                    >
                        {loadingMore && <Spinner size="xs" />}
                        {t('knowledge.memory_load_more', 'Load more ({count} remaining)', { count: total - items.length })}
                    </button>
                </div>
            )}
        </div>
    );
}
