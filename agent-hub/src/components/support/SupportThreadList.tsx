import type React from 'react';
import { Shield } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import SupportBulkBar from './SupportBulkBar';
import { CsatStars, SlaBadge, TagChips } from './SupportInboxBadges';
import type { SupportThread } from './SupportInboxPanel.types';
import { STATUS_DOT, formatRelative, priorityBadges, roleLabel, statusLabels } from './supportInboxLabels';
import type { useSupportBulk } from './useSupportInboxActions';
import type { useSupportThreadList } from './useSupportThreadList';
import FilterPills from '../shared/FilterPills';
import { INPUT_FIELD } from '../admin/Studio/SupportStudio/supportStyles';
import { CHIP_INFO } from '../mcpLibrary/ui';

interface SupportThreadListProps {
    list: ReturnType<typeof useSupportThreadList>;
    bulk: ReturnType<typeof useSupportBulk>;
    selectedId: string | null;
    setSelectedId: (id: string | null) => void;
    counter: (key: string) => number;
    activeTotal: number;
}

/** The list column of the inbox (the StudioShell sidebar): search, status filters, the bulk bar and the thread rows. */
export default function SupportThreadList({ list, bulk, selectedId, setSelectedId, counter, activeTotal }: SupportThreadListProps) {
    const { t } = useTranslation();
    const { threads, loading } = list;
    return (
        <div className="flex h-full min-h-0 flex-col">
            <SupportThreadFilters
                search={list.search}
                setSearch={list.setSearch}
                onSearch={list.fetchThreads}
                statusFilter={list.statusFilter}
                setStatusFilter={list.setStatusFilter}
                counter={counter}
                activeTotal={activeTotal}
            />
            <SupportBulkBar bulk={bulk} />
            <div className="flex-1 overflow-y-auto">
                {threads.length === 0 && !loading && (
                    <div className="p-8 text-center text-sm text-[var(--text-tertiary)]">{t('support.support_inbox_no_threads', 'No threads')}</div>
                )}
                {threads.map(th => (
                    <SupportThreadRow
                        key={th.id}
                        th={th}
                        selected={selectedId === th.id}
                        checked={bulk.selectedIds.has(th.id)}
                        onSelect={() => setSelectedId(th.id)}
                        onToggle={() => bulk.toggleSelected(th.id)}
                    />
                ))}
            </div>
        </div>
    );
}

interface SupportThreadFiltersProps {
    search: string;
    setSearch: (search: string) => void;
    onSearch: () => void;
    statusFilter: string;
    setStatusFilter: (filter: string) => void;
    counter: (key: string) => number;
    activeTotal: number;
}

function SupportThreadFilters({ search, setSearch, onSearch, statusFilter, setStatusFilter, counter, activeTotal }: SupportThreadFiltersProps) {
    const { t } = useTranslation();
    return (
        <>
            <div className="border-b border-[var(--border-default)] p-3">
                <input
                    value={search}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && onSearch()}
                    placeholder={t('support.support_inbox_search_subject_or_email', 'Search subject or email...')}
                    className={INPUT_FIELD}
                />
            </div>
            <div className="overflow-x-auto border-b border-[var(--border-default)] px-3 py-2">
                <FilterPills
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                        { value: 'active', label: t('support.inbox_filter_active', 'Active ({count})', { count: activeTotal }) },
                        ...(counter('followup') || statusFilter === 'followup'
                            ? [{ value: 'followup', label: t('support.inbox_filter_followup', 'Follow-up ({count})', { count: counter('followup') }) }]
                            : []),
                        { value: 'awaiting_agent', label: t('support.inbox_filter_awaiting', 'Awaiting ({count})', { count: counter('awaiting_agent') }) },
                        { value: 'awaiting_user', label: t('support.inbox_filter_sent', 'Sent ({count})', { count: counter('awaiting_user') }) },
                        { value: 'resolved', label: t('support.inbox_filter_resolved', 'Resolved ({count})', { count: counter('resolved') }) },
                        { value: 'all', label: t('support.inbox_filter_all', 'All') },
                    ]}
                />
            </div>
        </>
    );
}

interface SupportThreadRowProps {
    th: SupportThread;
    selected: boolean;
    checked: boolean;
    onSelect: () => void;
    onToggle: () => void;
}

function SupportThreadRow({ th, selected, checked, onSelect, onToggle }: SupportThreadRowProps) {
    const { t } = useTranslation();
    const priority = th.priority !== 'normal' ? priorityBadges(t)[th.priority] : undefined;
    return (
        <div
            className={`flex w-full cursor-pointer items-start gap-2 border-b border-[var(--border-default)] px-3 py-2.5 ${selected ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-secondary)]'}`}
            onClick={() => onSelect()}
        >
            <input
                type="checkbox"
                checked={checked}
                onClick={(e: React.MouseEvent<HTMLInputElement>) => e.stopPropagation()}
                onChange={() => onToggle()}
                className="mt-1 shrink-0 accent-[var(--accent-primary)]"
            />
            <div className="min-w-0 flex-1 text-left">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[th.status] || 'bg-[var(--text-tertiary)]'}`} />
                    <span className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
                        {statusLabels(t)[th.status] || th.status}
                    </span>
                    {th.source === 'marketing' && <span className={CHIP_INFO}>{t('support.support_inbox_marketing', 'marketing')}</span>}
                    {priority && <span className={priority.cls}>{priority.label}</span>}
                    <SlaBadge thread={th} />
                    <CsatStars score={th.csat_score} />
                </div>
                <div className="line-clamp-1 text-[13px] font-medium text-[var(--text-primary)]">{th.subject}</div>
                <div className="mt-0.5 flex items-center justify-between text-xs text-[var(--text-tertiary)]">
                    <span className="truncate">{th.requester_email}</span>
                    <span className="ml-2 shrink-0">{formatRelative(th.last_message_at)}</span>
                </div>
                {Array.isArray(th.tags) && th.tags.length > 0 && (
                    <div className="mt-1"><TagChips tags={th.tags} /></div>
                )}
                {(th.requester_org_role || th.requester_org_name) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                        <span className="inline-flex items-center gap-1 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[var(--text-secondary)]">
                            <Shield className="h-3 w-3" aria-hidden="true" /> {roleLabel(th.requester_org_role, t)}
                        </span>
                        {th.requester_org_name && <span className="truncate">{th.requester_org_name}</span>}
                    </div>
                )}
            </div>
        </div>
    );
}
