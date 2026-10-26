import { AlertTriangle, ExternalLink, Link2, Plus, RefreshCw, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AttachIssuePanel from './AttachIssuePanel';
import StateChip from './IssueStateChip';
import { API_BASE } from '../../utils/helpers';
import { linkedIssuesKey, useLinkedIssuesQuery, useYouTrackStatusQuery } from '../../api/queries/supportPanels';
import { useQueryClient } from '@tanstack/react-query';
import type { YouTrackStatus } from '../../api/queries/supportPanels';
import useConfirm from '../shared/useConfirm';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { logger } from '../../utils/logger';
import { mutate, ApiError, request, RefusedError, errorBody } from '../../api/mutate';

/**
 * The YouTrack issues attached to one support ticket.
 *
 * A LIST from the first pixel, never a single slot that later has to grow: a
 * ticket takes as many issues as it needs, and one issue collects every ticket
 * that reported it. The reverse direction is reachable from each row — "four
 * other tickets" expands to show which — because that is the whole payoff of
 * the many-to-many model.
 *
 * Everything shown here comes from the local snapshot the sync engine keeps
 * fresh, so opening a ticket never waits on YouTrack being up. When a refresh
 * failed the row says so and keeps the last good values rather than blanking.
 */

interface LinkedIssue {
    issueId: string;
    url?: string | null;
    summary?: string | null;
    state?: string | null;
    resolved?: boolean | null;
    kind?: string;
    reason?: string | null;
    otherTicketCount: number;
    syncError?: string | null;
    syncedAt?: string | null;
    lastComment?: { author?: string | null; at?: string | null; text?: unknown } | null;
}

interface ReverseThread {
    id: string;
    ref?: string;
    subject?: string;
    status?: string;
}

function relative(iso?: string | null): string {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

function ConnectionNotice({ status }: { status: YouTrackStatus | null }) {
    const { t } = useTranslation();
    if (!status) return null;
    if (!status.configured) {
        return (
            <div className="text-xs mb-2 text-[var(--text-muted)]">
                {t('support.linked_issues_youtrack_is_not_connected_yet_an_admin', 'YouTrack is not connected yet. An admin can set it up in the Connections tab.')}
            </div>
        );
    }
    if (!status.ok) {
        return (
            <div className="text-xs mb-2 flex items-start gap-1.5 [color:#b45309]!">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{t('support.linked_issues_can_t_reach_youtrack_host', 'Can\'t reach YouTrack ({host}):', { host: status.host })} {status.error}</span>
            </div>
        );
    }
    return null;
}

/** Why this row's data might be behind, in words an agent can act on. */
function SyncNote({ issue }: { issue: LinkedIssue }) {
    if (!issue.syncError) return null;
    const gone = issue.syncError.includes('not found');
    return (
        <span className="[color:#b45309]">
            · {gone ? 'no longer in YouTrack' : 'couldn’t refresh'}
            {!gone && issue.syncedAt ? ` — showing ${relative(issue.syncedAt)}` : ''}
        </span>
    );
}

interface IssueRowProps {
    issue: LinkedIssue;
    threadId: string;
    onDetach: (issueId: string) => void;
    onShowReverse: (issueId: string) => void;
    reverseOpen: boolean;
    reverseThreads: ReverseThread[];
}

function IssueRow({ issue, threadId, onDetach, onShowReverse, reverseOpen, reverseThreads }: IssueRowProps) {
    const { t } = useTranslation();
    return (
        <div className="rounded border px-2 py-1.5 border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <div className="flex items-start gap-2">
                <a
                    href={issue.url || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium shrink-0 inline-flex items-center gap-1 text-[var(--accent-primary)]"
                >
                    {issue.issueId} <ExternalLink className="w-3 h-3" />
                </a>
                <span className="text-xs flex-1 min-w-0 truncate text-[var(--text-primary)]">
                    {issue.summary || '—'}
                </span>
                <StateChip state={issue.state} resolved={issue.resolved} />
                <button
                    onClick={() => onDetach(issue.issueId)}
                    title={t('support.linked_issues_detach_from_this_ticket', 'Detach from this ticket')}
                    className="opacity-50 hover:opacity-100 shrink-0 text-[var(--text-muted)]"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {issue.lastComment && (
                <div className="text-xs mt-1 pl-1 border-l-2 border-[var(--border-default)] text-[var(--text-secondary)]">
                    <span className="text-[var(--text-muted)]">
                        {issue.lastComment.author || 'Someone'} · {relative(issue.lastComment.at)}:
                    </span>{' '}
                    {String(issue.lastComment.text).slice(0, 220)}
                    {String(issue.lastComment.text).length > 220 ? '…' : ''}
                </div>
            )}

            <div className="flex items-center gap-2 mt-1 text-xs text-[var(--text-muted)]">
                {issue.kind !== 'linked' && <span>{issue.kind === 'created' ? 'created here' : 'escalated'}</span>}
                {issue.reason && <span className="truncate">· {issue.reason}</span>}
                {issue.otherTicketCount > 0 && (
                    <button
                        onClick={() => onShowReverse(issue.issueId)}
                        className="inline-flex items-center gap-1 hover:underline text-[var(--text-secondary)]"
                    >
                        <Users className="w-3 h-3" />
                        {issue.otherTicketCount === 1 ? t('support.linked_issues_other_ticket_one', '{count} other ticket', { count: 1 }) : t('support.linked_issues_other_ticket_other', '{count} other tickets', { count: issue.otherTicketCount })}
                    </button>
                )}
                <SyncNote issue={issue} />
            </div>

            {reverseOpen && (
                <div className="mt-1.5 pl-1 border-l-2 flex flex-col gap-0.5 border-[var(--border-default)]">
                    {reverseThreads.length === 0 && (
                        <span className="text-xs text-[var(--text-muted)]">{t('support.linked_issues_loading', 'Loading…')}</span>
                    )}
                    {reverseThreads.filter((t: ReverseThread) => t.id !== threadId).map((t: ReverseThread) => (
                        <a
                            key={t.id}
                            href={`/app/admin/support/${t.id}`}
                            className="text-xs truncate hover:underline text-[var(--text-secondary)]"
                        >
                            {t.ref || t.id.slice(0, 8)} · {t.subject}{' '}
                            <span className="text-[var(--text-muted)]">({t.status})</span>
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}

interface LinkedIssuesPanelProps {
    thread?: { id?: string; ticket_ref?: string } | null;
    onChanged?: () => void;
}

const NO_ISSUES: LinkedIssue[] = [];

export default function LinkedIssuesPanel({ thread, onChanged }: LinkedIssuesPanelProps) {
    const { t } = useTranslation();
    const threadId = thread?.id || null;
    const { confirm, confirmDialog } = useConfirm();
    const queryClient = useQueryClient();
    const issuesQuery = useLinkedIssuesQuery<LinkedIssue>(threadId);
    const issues = issuesQuery.data ?? NO_ISSUES;
    const loading = issuesQuery.isFetching;
    const setIssues = (next: LinkedIssue[]) => queryClient.setQueryData(linkedIssuesKey(threadId), next);
    const [refreshing, setRefreshing] = useState<boolean>(false);
    const status: YouTrackStatus | null = useYouTrackStatusQuery().data ?? null;
    const [error, setError] = useState<string | null | undefined>(null);
    const [open, setOpen] = useState<boolean>(false);
    const [reverseFor, setReverseFor] = useState<string | null>(null);
    const [reverse, setReverse] = useState<ReverseThread[]>([]);

    const load = async () => { await issuesQuery.refetch(); };

    // Moving to another ticket closes the attach panel: a half-typed search
    // must never land on a different customer's ticket.
    useEffect(() => {
        setOpen(false);
        setReverseFor(null);
        setError(null);
    }, [threadId]);

    const detach = async (issueId: string) => {
        if (!(await confirm({ title: `Detach ${issueId} from this ticket?`, description: 'The issue itself stays in YouTrack.', confirmLabel: 'Detach', destructive: true }))) return;
        try {
            const res = await mutate(`${API_BASE}/api/support/threads/${threadId}/issues/${issueId}`, { method: 'DELETE' }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) { await load(); onChanged?.(); }
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    const refresh = async () => {
        setRefreshing(true);
        setError(null);
        try {
            let res: Response;
            try {
                res = await mutate(`${API_BASE}/api/support/threads/${threadId}/issues/refresh`, { method: 'POST' });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const d = errorBody(err) ?? {};
                setError(d.error || 'Refresh failed');
                return;
            }
            const d = await res.json().catch(() => ({}));
            setIssues(d.issues || []);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setRefreshing(false);
        }
    };

    const showReverse = async (issueId: string) => {
        if (reverseFor === issueId) { setReverseFor(null); return; }
        setReverseFor(issueId);
        setReverse([]);
        try {
            const res = await request(`${API_BASE}/api/support/youtrack/issues/${issueId}/threads`).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) { const d = await res.json(); setReverse(d.threads || []); }
        } catch (err) { logger.debug('the disclosure just stays empty', err); }
    };

    const connected = status?.configured && status?.ok;
    const oldestSync = useMemo(
        () => issues.map((i: LinkedIssue) => i.syncedAt).filter(Boolean).sort()[0] || null,
        [issues],
    );

    if (!threadId) return null;

    return (
        <div className="px-4 py-3 border-b border-[var(--border-default)]">
            <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                    <Link2 className="w-3.5 h-3.5" />
                    {t('support.linked_issues_development_issues', 'Development issues')}
                    {issues.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]">{issues.length}</span>
                    )}
                    {oldestSync && <span className="text-[var(--text-muted)]">{t('support.linked_issues_updated', '· updated {when}', { when: relative(oldestSync) })}</span>}
                </div>
                <div className="flex items-center gap-1.5">
                    {issues.length > 0 && (
                        <button
                            onClick={refresh}
                            disabled={refreshing}
                            title={t('support.linked_issues_pull_the_latest_state_from_youtrack', 'Pull the latest state from YouTrack')}
                            className="p-1 rounded hover:bg-[var(--bg-tertiary)] disabled:opacity-50 text-[var(--text-muted)]"
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                        </button>
                    )}
                    <button
                        onClick={() => setOpen((o: boolean) => !o)}
                        disabled={!connected}
                        title={connected ? 'Attach an existing issue' : 'YouTrack is not connected'}
                        className="px-2 py-1 rounded text-xs flex items-center gap-1 border disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        <Plus className="w-3 h-3" /> {t('support.linked_issues_attach_issue', 'Attach issue')}
                    </button>
                </div>
            </div>

            <ConnectionNotice status={status} />

            {error && (
                <div className="text-xs mb-2 flex items-start gap-1.5 [color:#dc2626]!">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{error}</span>
                </div>
            )}

            {issues.length === 0 && !loading && !open && (
                <div className="text-xs text-[var(--text-muted)]">
                    {t('support.linked_issues_no_issues_attached_search_before', 'No issues attached. Search before creating one — the bug may already be filed.')}
                </div>
            )}

            <div className="flex flex-col gap-1.5">
                {issues.map((i: LinkedIssue) => (
                    <IssueRow
                        key={i.issueId}
                        issue={i}
                        threadId={threadId}
                        onDetach={detach}
                        onShowReverse={showReverse}
                        reverseOpen={reverseFor === i.issueId}
                        reverseThreads={reverse}
                    />
                ))}
            </div>

            {open && (
                <AttachIssuePanel
                    threadId={threadId}
                    ticketRef={thread?.ticket_ref}
                    onAttached={() => { setOpen(false); load(); onChanged?.(); }}
                />
            )}
            {confirmDialog}
        </div>
    );
}
