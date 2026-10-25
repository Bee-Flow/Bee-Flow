import { AlertTriangle, Search, ShieldAlert } from 'lucide-react';
import { SetStateAction, Dispatch, useCallback, useState } from 'react';
import StateChip from './IssueStateChip';
import { authFetch, API_BASE } from '../../utils/helpers';
import { TranslateParams, useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { request, errorBody, RefusedError, mutate } from '../../api/mutate';

interface IssueSearchResult {
    id: string;
    summary?: string;
    state?: string | null;
    resolved?: boolean;
    linkedHere?: boolean;
    linkedTicketCount: number;
}

interface EgressRefusal {
    error?: string;
    detail?: string;
}

interface AttachIssuePanelProps {
    threadId?: string | null;
    ticketRef?: string;
    onAttached?: () => void;
}

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
export default function AttachIssuePanel({ threadId, ticketRef, onAttached }: AttachIssuePanelProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState<string>('');
    const [results, setResults] = useState<IssueSearchResult[]>([]);
    const [searching, setSearching] = useState<boolean>(false);
    const [picked, setPicked] = useState<Set<string>>(() => new Set<string>());
    const [attaching, setAttaching] = useState<boolean>(false);
    const [error, setError] = useState<string | null | undefined>(null);

    const [creating, setCreating] = useState<boolean>(false);
    const [summary, setSummary] = useState<string>('');
    const [description, setDescription] = useState<string>('');
    const [blocked, setBlocked] = useState<EgressRefusal | null>(null);
    const [submitting, setSubmitting] = useState<boolean>(false);

    const search = useCallback(async () => {
        const q = query.trim();
        if (!q) { setResults([]); return; }
        setSearching(true);
        setError(null);
        try {
            const params = new URLSearchParams({ q, threadId: threadId || '' });
            let res: Response;
            try {
                res = await request(`${API_BASE}/api/support/youtrack/search?${params}`);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const d = errorBody(err) ?? {};
                setError(d.error || 'Search failed');
                setResults([]);
                return;
            }
            const d = await res.json().catch(() => ({}));
            setResults(d.issues || []);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setSearching(false);
        }
    }, [query, threadId]);

    const togglePick = (id: string) => setPicked((prev: Set<string>) => {
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
            let res: Response;
            try {
                res = await mutate(`${API_BASE}/api/support/threads/${threadId}/issues`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ issueIds }),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const d = errorBody(err) ?? {};
                setError(d.error || 'Could not attach');
                return;
            }
            const d = await res.json().catch(() => ({}));
            setPicked(new Set());
            setQuery('');
            setResults([]);
            onAttached?.();
        } catch (e) {
            setError(errorMessage(e));
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
            setError(errorMessage(e));
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
        <div className="mt-2 rounded border p-2 border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <AttachIssuePanelSection query={query} setQuery={setQuery} search={search} t={t} inputStyle={inputStyle} searching={searching} />

            {error && (
                <div className="text-xs mt-1.5 flex items-start gap-1.5 [color:#dc2626]!">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{error}</span>
                </div>
            )}

            {results.length > 0 && (
                <div className="mt-2 flex flex-col gap-1 max-h-56 overflow-y-auto">
                    {results.map((r: IssueSearchResult) => (
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
                            <span className="font-medium shrink-0 text-[var(--accent-primary)]">{r.id}</span>
                            <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">{r.summary}</span>
                            <StateChip state={r.state} resolved={r.resolved} />
                            {r.linkedHere && <span className="shrink-0 text-[var(--text-muted)]">{t('support.attach_issue_attached', 'attached')}</span>}
                            {/* The count is the duplicate-stopper: seeing that four
                                tickets already report this is what makes an agent
                                attach instead of file. */}
                            {!r.linkedHere && r.linkedTicketCount > 0 && (
                                <span className="shrink-0 text-[var(--text-muted)]" title={t('support.attach_issue_other_tickets_already_report_this', 'Other tickets already report this')}>
                                    {r.linkedTicketCount === 1 ? t('support.attach_issue_ticket_one', '{count} ticket', { count: 1 }) : t('support.attach_issue_ticket_other', '{count} tickets', { count: r.linkedTicketCount })}
                                </span>
                            )}
                        </label>
                    ))}
                </div>
            )}

            <AttachIssuePanelSection2 setCreating={setCreating} setBlocked={setBlocked} creating={creating} picked={picked} attach={attach} attaching={attaching} />

            {creating && (
                <div className="mt-2 pt-2 border-t flex flex-col gap-1.5 border-[var(--border-default)]">
                    <input
                        value={summary}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSummary(e.target.value)}
                        placeholder={t('support.attach_issue_issue_title_describe_the_problem_not', 'Issue title — describe the problem, not the customer')}
                        className="px-2 py-1 rounded border text-xs"
                        style={inputStyle}
                    />
                    <textarea
                        value={description}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
                        rows={4}
                        placeholder={t('support.attach_issue_what_goes_wrong_in_your_own_words_don', 'What goes wrong, in your own words. Don\'t quote the customer — the ticket reference and a staff-only link are added for you.')}
                        className="px-2 py-1 rounded border text-xs resize-y"
                        style={inputStyle}
                    />
                    <div className="text-xs flex items-start gap-1.5 text-[var(--text-muted)]">
                        <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>
                            {t('support.attach_issue_the_customer_s_name_address_and', 'The customer\'s name, address and organisation never reach YouTrack. The issue carries ticket')} <strong>{ticketRef || '—'}</strong> {t('support.attach_issue_and_a_link_only_bee_flow_staff_can', 'and a link only Bee Flow staff can open.')}
                        </span>
                    </div>

                    {blocked && (
                        <div className="rounded px-2 py-1.5 text-xs flex items-start gap-1.5 [background:rgba(239,68,68,0.1)] [color:#dc2626]!">
                            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <span><strong>{blocked.error}</strong> {blocked.detail}</span>
                        </div>
                    )}

                    <div className="flex justify-end">
                        <button
                            onClick={create}
                            disabled={submitting || !summary.trim()}
                            className="px-2.5 py-1 rounded text-xs font-medium disabled:opacity-60 [background:var(--accent-primary)] [color:white]!"
                        >
                            {submitting ? 'Creating…' : 'Create and attach'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function AttachIssuePanelSection2({ setCreating, setBlocked, creating, picked, attach, attaching }: { setCreating: Dispatch<SetStateAction<boolean>>; setBlocked: Dispatch<SetStateAction<EgressRefusal | null>>; creating: boolean; picked: Set<string>; attach: () => Promise<void>; attaching: boolean; }) {
    return <div className="flex items-center justify-between gap-2 mt-2">
        <button
            onClick={() => { setCreating((c: boolean) => !c); setBlocked(null); } }
            className="text-xs hover:underline text-[var(--text-secondary)]"
        >
            {creating ? 'Back to search' : 'Nothing matches — create a new issue'}
        </button>
        {picked.size > 0 && (
            <button
                onClick={attach}
                disabled={attaching}
                className="px-2.5 py-1 rounded text-xs font-medium disabled:opacity-60 [background:var(--accent-primary)] [color:white]!"
            >
                {attaching ? 'Attaching…' : `Attach ${picked.size} issue${picked.size === 1 ? '' : 's'}`}
            </button>
        )}
    </div>;
}

function AttachIssuePanelSection({ query, setQuery, search, t, inputStyle, searching }: { query: string; setQuery: Dispatch<SetStateAction<string>>; search: () => Promise<void>; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; inputStyle: { background: string; borderColor: string; color: string; }; searching: boolean; }) {
    return <div className="flex items-center gap-1.5">
        <Search className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
        <input
            autoFocus
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && search()}
            placeholder={t('support.attach_issue_search_issues_or_paste_an_issue_number', 'Search issues, or paste an issue number like BFSF-441')}
            className="flex-1 px-2 py-1 rounded border text-xs"
            style={inputStyle} />
        <button
            onClick={search}
            disabled={searching}
            className="px-2 py-1 rounded text-xs border disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
        >
            {searching ? 'Searching…' : 'Search'}
        </button>
    </div>;
}
