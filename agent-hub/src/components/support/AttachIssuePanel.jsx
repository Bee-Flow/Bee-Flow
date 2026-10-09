import { AlertTriangle, Search, ShieldAlert } from 'lucide-react';
import { useCallback, useState } from 'react';
import StateChip from './IssueStateChip';
import { authFetch, API_BASE } from '../../utils/helpers';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * Attaching issues to a ticket: search first, create second.
 *
 * The ordering is the point. Searching existing issues is what stops the
 * duplicate BFSF-442 was written about, so it is the default view and
 * "create a new issue" only appears once an agent has looked and not found.
 *
 * The create form starts EMPTY rather than pre-filled from the customer's
 * message. Drafting from their words would only teach the tool to launder a
 * quote into the payload; the agent writes the problem in their own words,
 * which is the better bug report anyway. The server refuses anything carrying
 * personal data and says what to remove — see server/support/issueEgress.js.
 */
export default function AttachIssuePanel({ threadId, ticketRef, onAttached }) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [picked, setPicked] = useState(() => new Set());
    const [attaching, setAttaching] = useState(false);
    const [error, setError] = useState(null);

    const [creating, setCreating] = useState(false);
    const [summary, setSummary] = useState('');
    const [description, setDescription] = useState('');
    const [blocked, setBlocked] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    const search = useCallback(async () => {
        const q = query.trim();
        if (!q) { setResults([]); return; }
        setSearching(true);
        setError(null);
        try {
            const params = new URLSearchParams({ q, threadId: threadId || '' });
            const res = await authFetch(`${API_BASE}/api/support/youtrack/search?${params}`);
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { setError(d.error || 'Search failed'); setResults([]); return; }
            setResults(d.issues || []);
        } catch (e) {
            setError(e.message);
        } finally {
            setSearching(false);
        }
    }, [query, threadId]);

    const togglePick = (id) => setPicked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const attach = async () => {
        const issueIds = Array.from(picked);
        if (!issueIds.length) return;
        setAttaching(true);
        setError(null);
        try {
            const res = await authFetch(`${API_BASE}/api/support/threads/${threadId}/issues`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ issueIds }),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { setError(d.error || 'Could not attach'); return; }
            setPicked(new Set());
            setQuery('');
            setResults([]);
            onAttached?.();
        } catch (e) {
            setError(e.message);
        } finally {
            setAttaching(false);
        }
    };

    const create = async () => {
        setSubmitting(true);
        setBlocked(null);
        setError(null);
        try {
            const res = await authFetch(`${API_BASE}/api/support/threads/${threadId}/issues/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ summary, description }),
            });
            const d = await res.json().catch(() => ({}));
            // 422 is the egress refusal — not an error to apologise for, a list
            // of things to take out. Show it verbatim beside the field.
            if (res.status === 422) { setBlocked(d); return; }
            if (!res.ok) { setError(d.error || 'Could not create the issue'); return; }
            setCreating(false);
            setSummary('');
            setDescription('');
            onAttached?.();
        } catch (e) {
            setError(e.message);
        } finally {
            setSubmitting(false);
        }
    };

    const inputStyle = {
        background: 'var(--bg-card)',
        borderColor: 'var(--border-default)',
        color: 'var(--text-primary)',
    };

    return (
        <div className="mt-2 rounded border p-2" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
            <div className="flex items-center gap-1.5">
                <Search className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                <input
                    autoFocus
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && search()}
                    placeholder={t('support.attach_issue_search_issues_or_paste_an_issue_number', 'Search issues, or paste an issue number like BFSF-441')}
                    className="flex-1 px-2 py-1 rounded border text-xs"
                    style={inputStyle}
                />
                <button
                    onClick={search}
                    disabled={searching}
                    className="px-2 py-1 rounded text-xs border disabled:opacity-50"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                    {searching ? 'Searching…' : 'Search'}
                </button>
            </div>

            {error && (
                <div className="text-xs mt-1.5 flex items-start gap-1.5" style={{ color: '#dc2626' }}>
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{error}</span>
                </div>
            )}

            {results.length > 0 && (
                <div className="mt-2 flex flex-col gap-1 max-h-56 overflow-y-auto">
                    {results.map(r => (
                        <label
                            key={r.id}
                            className={`flex items-start gap-2 px-1.5 py-1 rounded text-xs ${r.linkedHere ? 'opacity-50' : 'cursor-pointer hover:bg-[var(--bg-tertiary)]'}`}
                        >
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                disabled={r.linkedHere}
                                checked={picked.has(r.id)}
                                onChange={() => togglePick(r.id)}
                            />
                            <span className="font-medium shrink-0" style={{ color: 'var(--accent-primary)' }}>{r.id}</span>
                            <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>{r.summary}</span>
                            <StateChip state={r.state} resolved={r.resolved} />
                            {r.linkedHere && <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>{t('support.attach_issue_attached', 'attached')}</span>}
                            {/* The count is the duplicate-stopper: seeing that four
                                tickets already report this is what makes an agent
                                attach instead of file. */}
                            {!r.linkedHere && r.linkedTicketCount > 0 && (
                                <span className="shrink-0" title={t('support.attach_issue_other_tickets_already_report_this', 'Other tickets already report this')} style={{ color: 'var(--text-muted)' }}>
                                    {r.linkedTicketCount === 1 ? t('support.attach_issue_ticket_one', '{count} ticket', { count: 1 }) : t('support.attach_issue_ticket_other', '{count} tickets', { count: r.linkedTicketCount })}
                                </span>
                            )}
                        </label>
                    ))}
                </div>
            )}

            <div className="flex items-center justify-between gap-2 mt-2">
                <button
                    onClick={() => { setCreating(c => !c); setBlocked(null); }}
                    className="text-xs hover:underline"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    {creating ? 'Back to search' : 'Nothing matches — create a new issue'}
                </button>
                {picked.size > 0 && (
                    <button
                        onClick={attach}
                        disabled={attaching}
                        className="px-2.5 py-1 rounded text-xs font-medium disabled:opacity-60"
                        style={{ background: 'var(--accent-primary)', color: 'white' }}
                    >
                        {attaching ? 'Attaching…' : `Attach ${picked.size} issue${picked.size === 1 ? '' : 's'}`}
                    </button>
                )}
            </div>

            {creating && (
                <div className="mt-2 pt-2 border-t flex flex-col gap-1.5" style={{ borderColor: 'var(--border-default)' }}>
                    <input
                        value={summary}
                        onChange={e => setSummary(e.target.value)}
                        placeholder={t('support.attach_issue_issue_title_describe_the_problem_not', 'Issue title — describe the problem, not the customer')}
                        className="px-2 py-1 rounded border text-xs"
                        style={inputStyle}
                    />
                    <textarea
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        rows={4}
                        placeholder={t('support.attach_issue_what_goes_wrong_in_your_own_words_don', 'What goes wrong, in your own words. Don\'t quote the customer — the ticket reference and a staff-only link are added for you.')}
                        className="px-2 py-1 rounded border text-xs resize-y"
                        style={inputStyle}
                    />
                    <div className="text-xs flex items-start gap-1.5" style={{ color: 'var(--text-muted)' }}>
                        <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>
                            {t('support.attach_issue_the_customer_s_name_address_and', 'The customer\'s name, address and organisation never reach YouTrack. The issue carries ticket')} <strong>{ticketRef || '—'}</strong> {t('support.attach_issue_and_a_link_only_bee_flow_staff_can', 'and a link only Bee Flow staff can open.')}
                        </span>
                    </div>

                    {blocked && (
                        <div className="rounded px-2 py-1.5 text-xs flex items-start gap-1.5" style={{ background: 'rgba(239,68,68,0.1)', color: '#dc2626' }}>
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <span><strong>{blocked.error}</strong> {blocked.detail}</span>
                        </div>
                    )}

                    <div className="flex justify-end">
                        <button
                            onClick={create}
                            disabled={submitting || !summary.trim()}
                            className="px-2.5 py-1 rounded text-xs font-medium disabled:opacity-60"
                            style={{ background: 'var(--accent-primary)', color: 'white' }}
                        >
                            {submitting ? 'Creating…' : 'Create and attach'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
