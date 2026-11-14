import { Plus, Settings, Inbox, LifeBuoy, RefreshCw, Search, BarChart3, Flag, AlertTriangle } from 'lucide-react';
import { useEffect, useState, useCallback, useRef } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import useDebouncedValue from '@/hooks/useDebouncedValue';
import InsightsPanel from './InsightsPanel';
import SupportSettings from './SupportSettings';
import useSupportInboxEvents from './useSupportInboxEvents';
import useTranslation from '@/hooks/useTranslation';
import StudioShell from '@/components/shared/StudioShell';
import type { SupportInbox, SupportUser } from './supportStudio.types';
import type { SupportThread, DotProps, SupportStudioProps, EmptyStateProps } from './index.types';
import { logger } from '@/utils/logger';
import { RefusedError } from '@/api/mutate';
import { NOT_SUPPORT_TAG, STATUS_COLORS, FILTER_IDS, AUTO_REFRESH_STORAGE_KEY, AUTO_REFRESH_OPTIONS, autoRefreshLabel, readStoredAutoRefreshMs, statusLabel, slaBreached } from './SupportStudio.helpers';
import { TicketDetail } from './TicketDetail';
import { apiRequest } from '@/api/typedRequest';

function Dot({ status }: DotProps) {
    return <span className={`inline-block w-2 h-2 rounded-full ${STATUS_COLORS[status] || 'text-[var(--text-tertiary)]'} [background-color:currentColor]`} />;
}

interface ThreadsAnswer { threads: SupportThread[]; counts: Record<string, number> }
const NO_THREADS: ThreadsAnswer = { threads: [], counts: {} };
const NO_INBOXES: SupportInbox[] = [];

/** The connected inboxes; a refusal or a failure keeps what is shown. */
function useStudioInboxes() {
    const queryClient = useQueryClient();
    const key = ['supportStudio', 'inboxes'] as const;
    const query = useQuery<SupportInbox[]>({
        queryKey: key,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            const kept = queryClient.getQueryData<SupportInbox[]>(key) ?? NO_INBOXES;
            try {
                const res = await apiRequest('GET /api/support-inbox/inboxes').catch((err: unknown) => {
                    if (err instanceof RefusedError) return null;
                    throw err;
                });
                return res ? ((await res.json()).inboxes || []) : kept;
            } catch (err) {
                logger.warn('support inboxes load failed', err);
                return kept;
            }
        },
    });
    const { refetch } = query;
    return { inboxes: query.data ?? NO_INBOXES, fetchInboxes: useCallback(() => { void refetch(); }, [refetch]) };
}

/**
 * The ticket list for the filter, read again on the chosen interval (the
 * reliable fallback when the SSE stream is idle-dropped, e.g. behind an embed
 * gateway). Typing in the search waits for a pause. A refusal or a failure keeps
 * the list that is shown.
 */
function useStudioThreads(activeInbox: string, statusFilter: string, search: string, limit: number, autoRefreshMs: number) {
    const settledSearch = useDebouncedValue(search, 250);
    const params = new URLSearchParams();
    if (activeInbox && activeInbox !== 'all') params.set('inbox', activeInbox);
    if (statusFilter === 'not_support') params.set('tag', NOT_SUPPORT_TAG);
    else if (statusFilter) params.set('status', statusFilter);
    if (settledSearch.trim()) params.set('q', settledSearch.trim());
    params.set('limit', String(limit));
    const qs = params.toString();
    const shown = useRef<ThreadsAnswer>(NO_THREADS);
    const query = useQuery<ThreadsAnswer>({
        queryKey: ['supportStudio', 'threads', qs],
        staleTime: 0,
        retry: false,
        placeholderData: keepPreviousData,
        refetchInterval: autoRefreshMs || false,
        refetchIntervalInBackground: true,
        queryFn: async () => {
            try {
                const res = await apiRequest('GET /api/support-inbox/threads', { query: params }).catch((err: unknown) => {
                    if (err instanceof RefusedError) return null;
                    throw err;
                });
                if (res) { const d = await res.json(); shown.current = { threads: d.threads || [], counts: d.counts || {} }; }
            } catch (err) { logger.warn('support threads load failed', err); }
            return shown.current;
        },
    });
    const { refetch } = query;
    const fetchThreads = useCallback(async () => { await refetch(); }, [refetch]);
    const answer = query.data ?? NO_THREADS;
    return { threads: answer.threads, counts: answer.counts, fetchThreads };
}

export default function SupportStudio({ user, initialTicketId = null }: SupportStudioProps) {
    const { t } = useTranslation();
    const [activeInbox, setActiveInbox] = useState('all');
    const [statusFilter, setStatusFilter] = useState('awaiting_agent');
    const [search, setSearch] = useState('');
    const [activeThreadId, setActiveThreadId] = useState<string | null>(initialTicketId);
    const [view, setView] = useState('inbox'); // 'inbox' | 'settings' | 'insights'
    const [limit, setLimit] = useState(100);
    const [refreshing, setRefreshing] = useState(false);
    const [autoRefreshMs, setAutoRefreshMs] = useState(readStoredAutoRefreshMs);

    const { inboxes, fetchInboxes } = useStudioInboxes();
    const { threads, counts, fetchThreads } = useStudioThreads(activeInbox, statusFilter, search, limit, autoRefreshMs);

    // Manual refresh — same fetch, but with a spinning indicator so the click
    // gives visible feedback even when the list comes back unchanged.
    const manualRefresh = useCallback(async () => {
        setRefreshing(true);
        try { await fetchThreads(); } finally { setRefreshing(false); }
    }, [fetchThreads]);

    // Persist the chosen interval so it sticks across reloads.
    useEffect(() => {
        try { window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefreshMs)); } catch (err) { logger.debug('storage unavailable', err); }
    }, [autoRefreshMs]);

    // Live updates: refresh the ticket list on any inbox event. The open ticket
    // refreshes via its own Refresh control / re-open.
    const onEvent = useCallback(() => { fetchThreads(); }, [fetchThreads]);
    useSupportInboxEvents(onEvent);

    const hasConnected = inboxes.some(i => i.connected);
    const filterCount = (id: string) => (id === 'not_support' ? counts.not_support : counts[id]);

    return (
        <StudioShell
            sidebarTitle={(
                <span className="flex items-center gap-2">
                    <LifeBuoy size={15} /> {t('studio.tab.support', 'Support')}
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 border border-amber-500/30">{t('studio_misc.support.beta', 'Beta')}</span>
                </span>
            )}
            sidebarActions={(
                <span className="flex items-center gap-1">
                    <button onClick={() => setView(v => v === 'insights' ? 'inbox' : 'insights')}
                        className={`p-1 rounded hover:bg-[var(--bg-secondary)] ${view === 'insights' ? 'text-[var(--accent-primary)]' : ''}`}
                        title={t('support.nav.insights', 'Insights')}
                        aria-label={t('support.nav.insights', 'Insights')}>
                        <BarChart3 size={14} />
                    </button>
                    <button onClick={() => setView(v => v === 'settings' ? 'inbox' : 'settings')}
                        className={`p-1 rounded hover:bg-[var(--bg-secondary)] ${view === 'settings' ? 'text-[var(--accent-primary)]' : ''}`}
                        title={t('support.nav.settings', 'Settings')}
                        aria-label={t('support.nav.settings', 'Settings')}>
                        <Settings size={14} />
                    </button>
                </span>
            )}
            sidebar={(
                <div className="flex flex-col gap-2 p-3">
                    <select value={activeInbox} onChange={e => setActiveInbox(e.target.value)}
                        className="text-sm rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5">
                        <option value="all">{t('support.nav.all_inboxes', 'All inboxes')}</option>
                        {inboxes.map(i => <option key={i.id} value={i.id}>{i.email_address || i.display_name || i.provider}</option>)}
                    </select>

                    <div className="relative">
                        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                        <input value={search} onChange={e => setSearch(e.target.value)}
                            placeholder={t('support.ticket.search', 'Search tickets…')}
                            className="w-full text-sm rounded border border-[var(--border-default)] bg-[var(--bg-primary)] pl-7 pr-2 py-1.5" />
                    </div>

                    <div className="flex flex-wrap gap-1">
                        {FILTER_IDS.map(id => (
                            <button key={id || 'all'} onClick={() => setStatusFilter(id)}
                                className={`text-[11px] px-2 py-1 rounded border ${statusFilter === id
                                    ? 'border-[var(--accent-primary)] bg-[var(--bg-secondary)] text-[var(--text-primary)]'
                                    : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}>
                                {statusLabel(t, id)}{filterCount(id) ? ` (${filterCount(id)})` : ''}
                            </button>
                        ))}
                    </div>

                    <div className="flex items-center justify-between mt-1 px-1">
                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{t('support.nav.tickets', 'Tickets')}</h4>
                        <div className="flex items-center gap-1">
                            <select value={autoRefreshMs} onChange={e => setAutoRefreshMs(Number(e.target.value))}
                                title={t('support.refresh.auto_title', 'Auto-refresh interval')}
                                className="text-[10px] rounded border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-tertiary)] px-1 py-0.5">
                                {AUTO_REFRESH_OPTIONS.map(o => (
                                    <option key={o.key} value={o.ms}>{autoRefreshLabel(t, o.key)}</option>
                                ))}
                            </select>
                            <button onClick={manualRefresh} disabled={refreshing}
                                className="p-0.5 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)] disabled:opacity-60"
                                title={t('support.common.refresh', 'Refresh')}
                                aria-label={t('support.common.refresh', 'Refresh')}>
                                <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
                            </button>
                        </div>
                    </div>

                    {threads.length === 0 && (
                        <div className="text-xs text-[var(--text-tertiary)] italic px-1">
                            {statusFilter === 'not_support'
                                ? t('support.empty.no_not_support', 'No non-support email here.')
                                : hasConnected ? t('support.empty.no_tickets', 'No tickets in this view.') : t('support.empty.connect_first', 'Connect a mailbox via Settings first.')}
                        </div>
                    )}
                    <div className="flex flex-col gap-1">
                        {threads.map(th => (
                            <button key={th.id} onClick={() => { setActiveThreadId(th.id); setView('inbox'); }}
                                className={`text-left text-xs px-3 py-2 rounded border ${activeThreadId === th.id
                                    ? 'border-[var(--accent-primary)] bg-[var(--bg-secondary)]'
                                    : 'border-transparent hover:bg-[var(--bg-secondary)]'}`}>
                                <div className="flex items-center gap-1.5">
                                    <Dot status={th.status} />
                                    <span className="font-medium truncate flex-1 text-[var(--text-primary)]">{th.subject || t('support.thread.no_subject', '(no subject)')}</span>
                                    {slaBreached(th) && <AlertTriangle size={11} className="text-rose-500" title={t('support.ticket.sla_breached', 'SLA breached')} />}
                                    {th.priority && th.priority !== 'normal' && <Flag size={11} className={th.priority === 'urgent' || th.priority === 'high' ? 'text-rose-500' : 'text-[var(--text-tertiary)]'} />}
                                </div>
                                <div className="text-[var(--text-tertiary)] truncate mt-0.5">{th.requester_email}</div>
                            </button>
                        ))}
                    </div>
                    {threads.length >= limit && (
                        <button onClick={() => setLimit(l => l + 100)}
                            className="text-[11px] px-2 py-1 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                            {t('support.nav.load_more', 'Load more')}
                        </button>
                    )}
                </div>
            )}
        >
            {view === 'settings'
                ? <SupportSettings inboxes={inboxes} user={user}
                    onChanged={() => { fetchInboxes(); fetchThreads(); }}
                    onOpenThread={(id) => { setActiveThreadId(id); setView('inbox'); }} />
                : view === 'insights'
                    ? <InsightsPanel inboxes={inboxes} activeInbox={activeInbox} onChanged={() => { fetchInboxes(); fetchThreads(); }} />
                    : activeThreadId
                        ? <TicketDetail key={activeThreadId} threadId={activeThreadId} user={user} onChanged={fetchThreads} autoRefreshMs={autoRefreshMs} />
                        : <EmptyState hasConnected={hasConnected} onSettings={() => setView('settings')} />}
        </StudioShell>
    );
}

function EmptyState({ hasConnected, onSettings }: EmptyStateProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col items-center justify-center h-full text-center gap-3 p-8">
            <Inbox size={32} className="text-[var(--text-tertiary)]" />
            <div className="text-sm font-semibold text-[var(--text-secondary)]">
                {hasConnected ? t('support.empty.select_ticket', 'Select a ticket') : t('support.empty.connect_mailbox', 'Connect your support mailbox')}
            </div>
            <div className="text-xs text-[var(--text-tertiary)] max-w-sm">
                {hasConnected
                    ? t('support.empty.select_hint', 'Pick a ticket on the left to view the conversation and reply with your AI agent.')
                    : t('support.empty.connect_hint', 'Connect a Gmail or Outlook support mailbox. Incoming emails become tickets you answer with an agent + knowledge base.')}
            </div>
            {!hasConnected && (
                <button onClick={onSettings} className="flex items-center gap-1 px-3 py-1.5 text-xs rounded text-white font-medium bg-[var(--accent-primary)]">
                    <Plus size={12} /> {t('support.empty.connect_cta', 'Connect mailbox')}
                </button>
            )}
        </div>
    );
}

declare module 'lucide-react' {
    // lucide passes `title` through to the <svg> and counts it as an accessible
    // name (hasA11yProp drops aria-hidden for it); its types just leave it out.
    interface LucideProps { title?: string }
}
