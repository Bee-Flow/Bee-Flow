import { AlertTriangle, ExternalLink, Link2, Plus, RefreshCw, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AttachIssuePanel from './AttachIssuePanel';
import StateChip from './IssueStateChip';
import { authFetch, API_BASE } from '../../utils/helpers';
import useConfirm from '../shared/useConfirm';

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

function relative(iso) {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

function ConnectionNotice({ status }) {
    if (!status) return null;
    if (!status.configured) {
        return (
            <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                YouTrack is not connected yet. An admin can set it up in the Connections tab.
            </div>
        );
    }
    if (!status.ok) {
        return (
            <div className="text-xs mb-2 flex items-start gap-1.5" style={{ color: '#b45309' }}>
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>Can&apos;t reach YouTrack ({status.host}): {status.error}</span>
            </div>
        );
    }
    return null;
}

/** Why this row's data might be behind, in words an agent can act on. */
function SyncNote({ issue }) {
    if (!issue.syncError) return null;
    const gone = issue.syncError.includes('not found');
    return (
        <span style={{ color: '#b45309' }}>
            · {gone ? 'no longer in YouTrack' : 'couldn’t refresh'}
            {!gone && issue.syncedAt ? ` — showing ${relative(issue.syncedAt)}` : ''}
        </span>
    );
}

function IssueRow({ issue, threadId, onDetach, onShowReverse, reverseOpen, reverseThreads }) {
    return (
        <div className="rounded border px-2 py-1.5" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
            <div className="flex items-start gap-2">
                <a
                    href={issue.url || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium shrink-0 inline-flex items-center gap-1"
                    style={{ color: 'var(--accent-primary)' }}
                >
                    {issue.issueId} <ExternalLink className="w-3 h-3" />
                </a>
                <span className="text-xs flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
                    {issue.summary || '—'}
                </span>
                <StateChip state={issue.state} resolved={issue.resolved} />
                <button
                    onClick={() => onDetach(issue.issueId)}
                    title="Detach from this ticket"
                    className="opacity-50 hover:opacity-100 shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {issue.lastComment && (
                <div className="text-xs mt-1 pl-1 border-l-2" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>
                        {issue.lastComment.author || 'Someone'} · {relative(issue.lastComment.at)}:
                    </span>{' '}
                    {String(issue.lastComment.text).slice(0, 220)}
                    {String(issue.lastComment.text).length > 220 ? '…' : ''}
                </div>
            )}

            <div className="flex items-center gap-2 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                {issue.kind !== 'linked' && <span>{issue.kind === 'created' ? 'created here' : 'escalated'}</span>}
                {issue.reason && <span className="truncate">· {issue.reason}</span>}
                {issue.otherTicketCount > 0 && (
                    <button
                        onClick={() => onShowReverse(issue.issueId)}
                        className="inline-flex items-center gap-1 hover:underline"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        <Users className="w-3 h-3" />
                        {issue.otherTicketCount} other ticket{issue.otherTicketCount === 1 ? '' : 's'}
                    </button>
                )}
                <SyncNote issue={issue} />
            </div>

            {reverseOpen && (
                <div className="mt-1.5 pl-1 border-l-2 flex flex-col gap-0.5" style={{ borderColor: 'var(--border-default)' }}>
                    {reverseThreads.length === 0 && (
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</span>
                    )}
                    {reverseThreads.filter(t => t.id !== threadId).map(t => (
                        <a
                            key={t.id}
                            href={`/app/admin/support/${t.id}`}
                            className="text-xs truncate hover:underline"
                            style={{ color: 'var(--text-secondary)' }}
                        >
                            {t.ref || t.id.slice(0, 8)} · {t.subject}{' '}
                            <span style={{ color: 'var(--text-muted)' }}>({t.status})</span>
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function LinkedIssuesPanel({ thread, onChanged }) {
    const threadId = thread?.id || null;
    const { confirm, confirmDialog } = useConfirm();
    const [issues, setIssues] = useState([]);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    const [open, setOpen] = useState(false);
    const [reverseFor, setReverseFor] = useState(null);
    const [reverse, setReverse] = useState([]);

    const load = useCallback(async () => {
        if (!threadId) return;
        setLoading(true);
        try {
            const res = await authFetch(`${API_BASE}/api/support/threads/${threadId}/issues`);
            if (res.ok) {
                const d = await res.json();
                setIssues(d.issues || []);
            }
        } catch (e) {
            console.warn('[Support] linked issues:', e.message);
        } finally {
            setLoading(false);
        }
    }, [threadId]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/support/youtrack/status`);
                if (res.ok) setStatus(await res.json());
            } catch { /* the panel degrades to "not connected" */ }
        })();
    }, []);

    // Moving to another ticket closes the attach panel: a half-typed search
    // must never land on a different customer's ticket.
    useEffect(() => {
        setOpen(false);
        setReverseFor(null);
        setError(null);
    }, [threadId]);

    const detach = async (issueId) => {
        if (!(await confirm({ title: `Detach ${issueId} from this ticket?`, description: 'The issue itself stays in YouTrack.', confirmLabel: 'Detach', destructive: true }))) return;
        try {
            const res = await authFetch(`${API_BASE}/api/support/threads/${threadId}/issues/${issueId}`, { method: 'DELETE' });
            if (res.ok) { await load(); onChanged?.(); }
        } catch (e) {
            setError(e.message);
        }
    };

    const refresh = async () => {
        setRefreshing(true);
        setError(null);
        try {
            const res = await authFetch(`${API_BASE}/api/support/threads/${threadId}/issues/refresh`, { method: 'POST' });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { setError(d.error || 'Refresh failed'); return; }
            setIssues(d.issues || []);
        } catch (e) {
            setError(e.message);
        } finally {
            setRefreshing(false);
        }
    };

    const showReverse = async (issueId) => {
        if (reverseFor === issueId) { setReverseFor(null); return; }
        setReverseFor(issueId);
        setReverse([]);
        try {
            const res = await authFetch(`${API_BASE}/api/support/youtrack/issues/${issueId}/threads`);
            if (res.ok) { const d = await res.json(); setReverse(d.threads || []); }
        } catch { /* the disclosure just stays empty */ }
    };

    const connected = status?.configured && status?.ok;
    const oldestSync = useMemo(
        () => issues.map(i => i.syncedAt).filter(Boolean).sort()[0] || null,
        [issues],
    );

    if (!threadId) return null;

    return (
        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
            <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    <Link2 className="w-3.5 h-3.5" />
                    Development issues
                    {issues.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)' }}>{issues.length}</span>
                    )}
                    {oldestSync && <span style={{ color: 'var(--text-muted)' }}>· updated {relative(oldestSync)}</span>}
                </div>
                <div className="flex items-center gap-1.5">
                    {issues.length > 0 && (
                        <button
                            onClick={refresh}
                            disabled={refreshing}
                            title="Pull the latest state from YouTrack"
                            className="p-1 rounded hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                            style={{ color: 'var(--text-muted)' }}
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                        </button>
                    )}
                    <button
                        onClick={() => setOpen(o => !o)}
                        disabled={!connected}
                        title={connected ? 'Attach an existing issue' : 'YouTrack is not connected'}
                        className="px-2 py-1 rounded text-xs flex items-center gap-1 border disabled:opacity-50"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                    >
                        <Plus className="w-3 h-3" /> Attach issue
                    </button>
                </div>
            </div>

            <ConnectionNotice status={status} />

            {error && (
                <div className="text-xs mb-2 flex items-start gap-1.5" style={{ color: '#dc2626' }}>
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{error}</span>
                </div>
            )}

            {issues.length === 0 && !loading && !open && (
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    No issues attached. Search before creating one — the bug may already be filed.
                </div>
            )}

            <div className="flex flex-col gap-1.5">
                {issues.map(i => (
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
