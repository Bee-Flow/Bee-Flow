import type React from 'react';
import { Shield } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import SupportBulkBar from './SupportBulkBar';
import { CsatStars, SlaBadge, TagChips } from './SupportInboxBadges';
import type { SupportThread } from './SupportInboxPanel.types';
import { PRIORITY_BADGES, STATUS_DOT, STATUS_LABELS, formatRelative, roleLabel } from './supportInboxLabels';
import type { useSupportBulk } from './useSupportInboxActions';
import type { useSupportThreadList } from './useSupportThreadList';

interface SupportThreadListProps {
    list: ReturnType<typeof useSupportThreadList>;
    bulk: ReturnType<typeof useSupportBulk>;
    selectedId: string | null;
    setSelectedId: (id: string | null) => void;
    counter: (key: string) => number;
    activeTotal: number;
}

/** The left column of the inbox: search, status filters, the bulk bar and the thread rows. */
export default function SupportThreadList({ list, bulk, selectedId, setSelectedId, counter, activeTotal }: SupportThreadListProps) {
    const { t } = useTranslation();
    const { threads, loading } = list;
    return (
        <div className="col-span-4 border-r flex flex-col min-h-0 border-[var(--border-default)]">
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
                    <div className="p-8 text-center text-sm text-[var(--text-muted)]">{t('support.support_inbox_no_threads', 'No threads')}</div>
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
            <div className="p-3 border-b flex items-center gap-2 border-[var(--border-default)]">
                <input
                    value={search}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && onSearch()}
                    placeholder={t('support.support_inbox_search_subject_or_email', 'Search subject or email...')}
                    className="flex-1 px-3 py-1.5 rounded-md border text-sm [background:var(--bg-card)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                />
            </div>
            <div className="px-3 py-2 border-b flex gap-1 overflow-x-auto border-[var(--border-default)]">
                {[
                    { id: 'active', label: `Active (${activeTotal})` },
                    ...(counter('followup') || statusFilter === 'followup'
                        ? [{ id: 'followup', label: `Follow-up (${counter('followup')})` }]
                        : []),
                    { id: 'awaiting_agent', label: `Awaiting (${counter('awaiting_agent')})` },
                    { id: 'awaiting_user', label: `Sent (${counter('awaiting_user')})` },
                    { id: 'resolved', label: `Resolved (${counter('resolved')})` },
                    { id: 'all', label: 'All' },
                ].map(f => (
                    <button
                        key={f.id}
                        onClick={() => setStatusFilter(f.id)}
                        className="px-2 py-1 rounded-md text-xs whitespace-nowrap"
                        style={{
                            background: statusFilter === f.id ? 'var(--accent-primary)' : 'var(--bg-card)',
                            color: statusFilter === f.id ? 'white' : 'var(--text-secondary)',
                            border: '1px solid var(--border-default)',
                        }}
                    >{f.label}</button>
                ))}
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
    return (
        <div
            className="w-full flex items-start gap-2 px-3 py-2.5 border-b hover:bg-[var(--bg-tertiary)] cursor-pointer"
            onClick={() => onSelect()}
            style={{
                borderColor: 'var(--border-default)',
                background: selected ? 'var(--bg-tertiary)' : 'transparent',
            }}
        >
            <input
                type="checkbox"
                checked={checked}
                onClick={(e: React.MouseEvent<HTMLInputElement>) => e.stopPropagation()}
                onChange={() => onToggle()}
                className="mt-1 shrink-0"
            />
            <div className="min-w-0 flex-1 text-left">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="w-2 h-2 rounded-full" style={{ background: STATUS_DOT[th.status] }} />
                <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    {STATUS_LABELS[th.status] || th.status}
                </span>
                {th.source === 'marketing' && (
                    <span className="text-xs px-1.5 py-0.5 rounded [background:rgba(59,130,246,0.12)] [color:#2563eb]!">{t('support.support_inbox_marketing', 'marketing')}</span>
                )}
                {PRIORITY_BADGES[th.priority] && th.priority !== 'normal' && (
                    <span className="text-xs px-1.5 py-0.5 rounded" style={PRIORITY_BADGES[th.priority] && { background: PRIORITY_BADGES[th.priority].bg, color: PRIORITY_BADGES[th.priority].fg }}>
                        {PRIORITY_BADGES[th.priority].label}
                    </span>
                )}
                <SlaBadge thread={th} />
                <CsatStars score={th.csat_score} />
            </div>
            <div className="text-sm font-medium line-clamp-1 text-[var(--text-primary)]">{th.subject}</div>
            <div className="text-xs mt-0.5 flex items-center justify-between text-[var(--text-muted)]">
                <span className="truncate">{th.requester_email}</span>
                <span className="shrink-0 ml-2">{formatRelative(th.last_message_at)}</span>
            </div>
            {Array.isArray(th.tags) && th.tags.length > 0 && (
                <div className="mt-1"><TagChips tags={th.tags} /></div>
            )}
            {(th.requester_org_role || th.requester_org_name) && (
                <div className="text-xs mt-1 flex items-center gap-1.5 flex-wrap text-[var(--text-muted)]">
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <Shield className="w-3 h-3" /> {roleLabel(th.requester_org_role)}
                    </span>
                    {th.requester_org_name && (
                        <span className="truncate">{th.requester_org_name}</span>
                    )}
                </div>
            )}
            </div>
        </div>
    );
}
