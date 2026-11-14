import { AlertTriangle, ExternalLink, Link2, Plus, RefreshCw, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AttachIssuePanel from './AttachIssuePanel';
import StateChip from './IssueStateChip';
import { linkedIssuesKey, useLinkedIssuesQuery, useYouTrackStatusQuery } from '../../api/queries/supportPanels';
import { useQueryClient } from '@tanstack/react-query';
import type { YouTrackStatus } from '../../api/queries/supportPanels';
import useConfirm from '../shared/useConfirm';
import { useTranslation, type TranslateFn } from '../../hooks/useTranslation';
import { ALERT_ERROR, ALERT_WARNING, QUIET_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import { errorMessage } from '../../utils/caughtError';
import { logger } from '../../utils/logger';
import { ApiError, RefusedError, errorBody } from '../../api/mutate';
import { apiRequest } from '@/api/typedRequest';

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

function relative(iso: string | null | undefined, t: TranslateFn): string {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return t('support.linked_issues_just_now', 'just now');
    if (m < 60) return t('support.linked_issues_minutes_ago', '{count}m ago', { count: m });
    const h = Math.round(m / 60);
    if (h < 24) return t('support.linked_issues_hours_ago', '{count}h ago', { count: h });
    return t('support.linked_issues_days_ago', '{count}d ago', { count: Math.round(h / 24) });
}

function ConnectionNotice({ status }: { status: YouTrackStatus | null }) {
    const { t } = useTranslation();
    if (!status) return null;
    if (!status.configured) {
        return (
            <div className="mb-2 text-xs text-[var(--text-tertiary)]">
                {t('support.linked_issues_youtrack_is_not_connected_yet_an_admin', 'YouTrack is not connected yet. An admin can set it up in the Connections tab.')}
            </div>
        );
    }
    if (!status.ok) {
        return (
            <div className={`${ALERT_WARNING} mb-2`}>
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{t('support.linked_issues_can_t_reach_youtrack_host', 'Can\'t reach YouTrack ({host}):', { host: status.host })} {status.error}</span>
            </div>
        );
    }
    return null;
}

/** Why this row's data might be behind, in words an agent can act on. */
function SyncNote({ issue }: { issue: LinkedIssue }) {
    const { t } = useTranslation();
    if (!issue.syncError) return null;
    const gone = issue.syncError.includes('not found');
    return (
        <span className="text-[var(--warning-ink)]">
            · {gone ? t('support.linked_issues_no_longer_in_youtrack', 'no longer in YouTrack') : t('support.linked_issues_couldnt_refresh', 'couldn’t refresh')}
            {!gone && issue.syncedAt ? t('support.linked_issues_showing_when', ' — showing {when}', { when: relative(issue.syncedAt, t) }) : ''}
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
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-2">
            <div className="flex items-start gap-2">
                <a
                    href={issue.url || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--text-primary)] underline-offset-2 hover:underline"
                >
                    {issue.issueId} <ExternalLink className="h-3 w-3 text-[var(--text-tertiary)]" aria-hidden="true" />
                </a>
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]">
                    {issue.summary || '—'}
                </span>
                <StateChip state={issue.state} resolved={issue.resolved} />
                <button
                    onClick={() => onDetach(issue.issueId)}
                    title={t('support.linked_issues_detach_from_this_ticket', 'Detach from this ticket')}
                    aria-label={t('support.linked_issues_detach_from_this_ticket', 'Detach from this ticket')}
                    className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </div>

            {issue.lastComment && (
                <div className="mt-1 border-l-2 border-[var(--border-default)] pl-1.5 text-xs text-[var(--text-secondary)]">
                    <span className="text-[var(--text-tertiary)]">
                        {issue.lastComment.author || t('support.linked_issues_someone', 'Someone')} · {relative(issue.lastComment.at, t)}:
                    </span>{' '}
                    {String(issue.lastComment.text).slice(0, 220)}
                    {String(issue.lastComment.text).length > 220 ? '…' : ''}
                </div>
            )}

            <div className="mt-1 flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                {issue.kind !== 'linked' && <span>{issue.kind === 'created' ? t('support.linked_issues_created_here', 'created here') : t('support.linked_issues_escalated', 'escalated')}</span>}
                {issue.reason && <span className="truncate">· {issue.reason}</span>}
                {issue.otherTicketCount > 0 && (
                    <button
                        onClick={() => onShowReverse(issue.issueId)}
                        className="inline-flex items-center gap-1 hover:underline text-[var(--text-secondary)]"
                    >
                        <Users className="h-3 w-3" aria-hidden="true" />
                        {issue.otherTicketCount === 1 ? t('support.linked_issues_other_ticket_one', '{count} other ticket', { count: 1 }) : t('support.linked_issues_other_ticket_other', '{count} other tickets', { count: issue.otherTicketCount })}
                    </button>
                )}
                <SyncNote issue={issue} />
            </div>

            {reverseOpen && (
                <div className="mt-1.5 flex flex-col gap-0.5 border-l-2 border-[var(--border-default)] pl-1.5">
                    {reverseThreads.length === 0 && (
                        <span className="text-xs text-[var(--text-tertiary)]">{t('support.linked_issues_loading', 'Loading…')}</span>
                    )}
                    {reverseThreads.filter((t: ReverseThread) => t.id !== threadId).map((t: ReverseThread) => (
                        <a
                            key={t.id}
                            href={`/app/admin/support/${t.id}`}
                            className="text-xs truncate hover:underline text-[var(--text-secondary)]"
                        >
                            {t.ref || t.id.slice(0, 8)} · {t.subject}{' '}
                            <span className="text-[var(--text-tertiary)]">({t.status})</span>
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
        if (!(await confirm({ title: t('support.linked_issues_detach_title', 'Detach {id} from this ticket?', { id: issueId }), description: t('support.linked_issues_detach_description', 'The issue itself stays in YouTrack.'), confirmLabel: t('support.linked_issues_detach', 'Detach'), destructive: true }))) return;
        try {
            const res = await apiRequest('DELETE /api/support/threads/{id}/issues/{issueId}', { params: { id: String(threadId), issueId } }).catch((err: unknown) => {
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
                res = await apiRequest('POST /api/support/threads/{id}/issues/refresh', { params: { id: String(threadId) } });
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
            const res = await apiRequest('GET /api/support/youtrack/issues/{issueId}/threads', { params: { issueId } }).catch((err: unknown) => {
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
                    <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('support.linked_issues_development_issues', 'Development issues')}
                    {issues.length > 0 && (
                        <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-px text-[11px]">{issues.length}</span>
                    )}
                    {oldestSync && <span className="font-normal text-[var(--text-tertiary)]">{t('support.linked_issues_updated', '· updated {when}', { when: relative(oldestSync, t) })}</span>}
                </div>
                <div className="flex items-center gap-1.5">
                    {issues.length > 0 && (
                        <button
                            onClick={refresh}
                            disabled={refreshing}
                            title={t('support.linked_issues_pull_the_latest_state_from_youtrack', 'Pull the latest state from YouTrack')}
                            aria-label={t('support.linked_issues_pull_the_latest_state_from_youtrack', 'Pull the latest state from YouTrack')}
                            className={QUIET_BTN}
                        >
                            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                        </button>
                    )}
                    <button
                        onClick={() => setOpen((o: boolean) => !o)}
                        disabled={!connected}
                        title={connected ? t('support.linked_issues_attach_existing', 'Attach an existing issue') : t('support.linked_issues_not_connected', 'YouTrack is not connected')}
                        className={SECONDARY_BTN}
                    >
                        <Plus className="h-3 w-3" aria-hidden="true" /> {t('support.linked_issues_attach_issue', 'Attach issue')}
                    </button>
                </div>
            </div>

            <ConnectionNotice status={status} />

            {error && (
                <div className={`${ALERT_ERROR} mb-2`}>
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{error}</span>
                </div>
            )}

            {issues.length === 0 && !loading && !open && (
                <div className="text-xs text-[var(--text-tertiary)]">
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
