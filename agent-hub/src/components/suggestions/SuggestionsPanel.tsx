// The AI's proposed changes to a page: a drawer beside the page.
//
// The AI never writes into a page others can see; it proposes, and a person
// accepts or rejects each change (or a whole batch). Open suggestions are
// grouped by batch, each with a short summary and the words that change.
// Their passages are painted in the page (`highlight`, the CSS highlight
// `bee-suggest`); clicking a card, or a passage in the page, focuses the pair.
//
// Keyboard (plain letters, so none of the editor's Mod shortcuts in
// editor/react/shortcuts.ts clash): J / K next and previous, A accept, R
// reject, while the list has focus. Viewers see the list without buttons.

import { Check, Sparkles, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { CommentAnchor } from '../../api/queries/comments';
import {
    useDocumentSuggestions, useResolveSuggestions, type ResolveResult, type Suggestion, type SuggestionTarget,
} from '../../api/queries/suggestions';
import { hunkWords, type Hunk } from '../../editor/suggest';
import { useTranslation } from '../../hooks/useTranslation';
import { LoadingRow, Notice } from '../projects/workspace/workspaceUi';
import { formatMessageTime } from '../projects/workspace/chat/messageGroups';

export type HighlightSuggestions = (list: Array<{ id: string; anchor: CommentAnchor }>, activeId?: string | null) => void;

export interface SuggestionsPanelProps {
    documentId: string;
    /** Editors accept and reject; viewers only read. */
    canEdit: boolean;
    /** The suggestion in focus (set by a click in the page too). */
    focusedId: string | null;
    onFocus: (id: string | null) => void;
    highlight?: HighlightSuggestions;
    /** Scroll the page to a passage; false when its text is gone. */
    scrollToAnchor?: (anchor: CommentAnchor) => boolean;
    /** Accepted: the page was written, show it. */
    onAccepted?: (r: ResolveResult) => void;
    onClose?: () => void;
    className?: string;
}

const DEL = 'bg-[color-mix(in_srgb,var(--error)_12%,transparent)] text-[var(--text-secondary)] line-through';
const INS = 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--text-primary)]';
const BTN = 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] disabled:opacity-50';
const BTN_PRIMARY = `${BTN} bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]`;
const BTN_PLAIN = `${BTN} bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]`;

/** The words that change in one suggestion, struck and added; the summary when the diff cannot be made. */
function WordDiff({ s }: { s: Suggestion }) {
    const { t } = useTranslation();
    const diff = useMemo(() => {
        try { return hunkWords({ anchor: s.anchor, before: s.before, after: s.after, summary: s.summary } as unknown as Hunk); } catch { return null; }
    }, [s]);
    if (!diff || !diff.words?.length) return null;
    return (
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-primary)] break-words" data-testid="suggestion-diff">
            {diff.words.map((w, i) => {
                if (w.op === 'delete') return <del key={i} className={DEL} aria-label={t('suggestions.remove_label', 'Removed text')}>{w.text}</del>;
                if (w.op === 'insert') return <ins key={i} className={`${INS} no-underline`} aria-label={t('suggestions.insert_label', 'New text')}>{w.text}</ins>;
                return <span key={i}>{w.text}</span>;
            })}
        </p>
    );
}

interface CardProps {
    s: Suggestion;
    focused: boolean;
    stale: boolean;
    canEdit: boolean;
    busy: boolean;
    onFocus: () => void;
    onResolve: (action: 'accept' | 'reject') => void;
}

function SuggestionCard({ s, focused, stale, canEdit, busy, onFocus, onResolve }: CardProps) {
    const { t } = useTranslation();
    return (
        <li
            data-testid="suggestion-card" data-suggestion-id={s.id} data-focused={focused ? 'true' : 'false'}
            aria-current={focused ? 'true' : undefined}
            className={`rounded-lg border p-2.5 ${focused ? 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)]'}`}
        >
            <button type="button" onClick={onFocus} className="block w-full text-left text-xs font-medium text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]">
                {s.summary}
            </button>
            {stale
                ? <p className="mt-1.5 text-xs text-[var(--text-tertiary)]" data-testid="suggestion-stale">{t('suggestions.stale', 'The text changed since; this suggestion no longer fits.')}</p>
                : <WordDiff s={s} />}
            {canEdit && s.status === 'open' && (
                <div className="mt-2 flex gap-1.5">
                    <button type="button" className={BTN_PRIMARY} disabled={busy || stale} onClick={() => onResolve('accept')} aria-label={t('suggestions.accept_one', 'Accept this suggestion')}>
                        <Check size={12} aria-hidden="true" />{t('suggestions.accept', 'Accept')}
                    </button>
                    <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => onResolve('reject')} aria-label={t('suggestions.reject_one', 'Reject this suggestion')}>
                        <X size={12} aria-hidden="true" />{t('suggestions.reject', 'Reject')}
                    </button>
                </div>
            )}
        </li>
    );
}

/** Open suggestions of one batch, the batch's time and its Accept all / Reject all. */
function BatchGroup({ items, canEdit, busy, locale, onBatch, children }: {
    items: Suggestion[]; canEdit: boolean; busy: boolean; locale: string;
    onBatch: (action: 'accept' | 'reject') => void; children: React.ReactNode;
}) {
    const { t } = useTranslation();
    const first = items[0];
    const time = formatMessageTime(first.createdAt, locale);
    return (
        <section className="space-y-2" data-testid="suggestion-batch" data-batch-id={first.batchId}>
            <header className="flex flex-wrap items-center gap-2">
                {first.authorKind === 'ai' && (
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <Sparkles size={10} aria-hidden="true" />{t('suggestions.ai_badge', 'AI')}
                    </span>
                )}
                <span className="text-xs text-[var(--text-tertiary)]">
                    {first.authorKind === 'ai' ? t('suggestions.batch_label', 'Suggested by the AI, {time}', { time }) : t('suggestions.batch_label_user', 'Suggested, {time}', { time })}
                </span>
                {canEdit && (
                    <span className="ml-auto flex gap-1.5">
                        <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => onBatch('accept')}>{t('suggestions.accept_all', 'Accept all')}</button>
                        <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => onBatch('reject')}>{t('suggestions.reject_all', 'Reject all')}</button>
                    </span>
                )}
            </header>
            <ul className="space-y-2">{children}</ul>
        </section>
    );
}

/** Group suggestions by batch, batches and their members in the order they were made. */
export function groupByBatch(list: Suggestion[]): Suggestion[][] {
    const groups = new Map<string, Suggestion[]>();
    for (const s of list) {
        const g = groups.get(s.batchId);
        if (g) g.push(s); else groups.set(s.batchId, [s]);
    }
    return [...groups.values()];
}

export default function SuggestionsPanel(props: SuggestionsPanelProps) {
    const { documentId, canEdit, focusedId, onFocus, onClose } = props;
    const { t, locale } = useTranslation();
    const query = useDocumentSuggestions(documentId, { live: false });
    const [notice, setNotice] = useState<string | null>(null);
    const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
    const resolve = useResolveSuggestions(documentId, { onAccepted: props.onAccepted });
    const root = useRef<HTMLDivElement>(null);

    const all = useMemo(() => query.data?.suggestions || [], [query.data]);
    const open = useMemo(() => all.filter(s => s.status === 'open'), [all]);
    const done = useMemo(() => all.filter(s => s.status !== 'open'), [all]);
    const batches = useMemo(() => groupByBatch(open), [open]);
    const order = useMemo(() => batches.flat(), [batches]);
    const isStale = useCallback((s: Suggestion) => s.status === 'stale' || missing.has(s.id), [missing]);

    // Paint the open suggestions' passages; clear them when the panel goes.
    const painter = useRef(props.highlight);
    useEffect(() => { painter.current = props.highlight; });
    const list = useMemo(() => order.filter(s => !isStale(s)).map(s => ({ id: s.id, anchor: s.anchor })), [order, isStale]);
    const key = list.map(h => `${h.id}:${h.anchor.quote}`).join('\u0000');
    const latest = useRef(list);
    useEffect(() => { latest.current = list; }, [list]);
    useEffect(() => {
        try { painter.current?.(latest.current, focusedId); } catch { /* highlighting is a courtesy */ }
    }, [key, focusedId]);
    useEffect(() => () => { try { painter.current?.([], null); } catch { /* nothing to clear */ } }, []);

    const focus = useCallback((s: Suggestion | null) => {
        onFocus(s ? s.id : null);
        if (!s || !props.scrollToAnchor) return;
        let found = false;
        try { found = props.scrollToAnchor(s.anchor); } catch { found = false; }
        if (!found) setMissing(prev => new Set(prev).add(s.id));
    }, [onFocus, props]);

    const run = useCallback((target: SuggestionTarget, action: 'accept' | 'reject') => {
        setNotice(null);
        resolve.mutate({ target, action }, {
            onSuccess: (r) => { if (r.stale.length) setNotice(t('suggestions.some_stale', '{count} suggestion(s) no longer fit and were skipped.', { count: r.stale.length })); },
            onError: (e) => {
                const status = e instanceof ApiError ? e.status : undefined;
                setNotice(status === 409
                    ? t('suggestions.nothing_applied', 'Nothing could be applied: the text changed since these suggestions were made.')
                    : t('suggestions.error_resolve', 'Could not apply that. Try again.'));
            },
        });
    }, [resolve, t]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const el = e.target as HTMLElement;
        if (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable) return;
        const k = e.key.toLowerCase();
        if (!['j', 'k', 'a', 'r'].includes(k) || !order.length) return;
        const at = order.findIndex(s => s.id === focusedId);
        if (k === 'j' || k === 'k') {
            e.preventDefault();
            const next = k === 'j' ? Math.min(order.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
            focus(order[next]);
            return;
        }
        const current = at >= 0 ? order[at] : null;
        if (!current || !canEdit || resolve.isPending) return;
        if (k === 'a' && isStale(current)) return;
        e.preventDefault();
        run({ kind: 'one', id: current.id }, k === 'a' ? 'accept' : 'reject');
        const after = order[at + 1] || order[at - 1] || null;
        onFocus(after ? after.id : null);
    };

    let body: React.ReactNode;
    if (query.isPending) body = <LoadingRow label={t('suggestions.title', 'Suggestions')} />;
    else if (query.isError) body = <Notice tone="error">{t('suggestions.error_load', 'Could not load the suggestions.')}</Notice>;
    else if (!all.length) body = <p className="text-xs text-[var(--text-tertiary)]" data-testid="suggestions-empty">{t('suggestions.empty', 'No suggestions. When the AI proposes changes to this page, they wait here for you to accept or reject them.')}</p>;
    else {
        body = (
            <>
                {batches.map(items => (
                    <BatchGroup key={items[0].batchId} items={items} canEdit={canEdit} busy={resolve.isPending} locale={locale} onBatch={(a) => run({ kind: 'batch', id: items[0].batchId }, a)}>
                        {items.map(s => (
                            <SuggestionCard key={s.id} s={s} focused={s.id === focusedId} stale={isStale(s)} canEdit={canEdit} busy={resolve.isPending}
                                onFocus={() => focus(s)} onResolve={(a) => run({ kind: 'one', id: s.id }, a)} />
                        ))}
                    </BatchGroup>
                ))}
                {done.length > 0 && (
                    <details className="text-xs text-[var(--text-tertiary)]" data-testid="suggestions-handled">
                        <summary className="cursor-pointer">{t('suggestions.resolved_section', 'Handled ({count})', { count: done.length })}</summary>
                        <ul className="mt-2 space-y-1.5">
                            {done.map(s => (
                                <li key={s.id} data-testid="suggestion-handled">
                                    <span className="font-medium">{s.status === 'accepted' ? t('suggestions.resolved_accepted', 'Accepted') : s.status === 'rejected' ? t('suggestions.resolved_rejected', 'Rejected') : t('suggestions.resolved_stale', 'No longer fits')}</span>
                                    {': '}{s.summary}
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
            </>
        );
    }

    return (
        // The list is a focus stop of its own so the letter keys only work while it is in use.
        <div ref={root} role="region" aria-label={t('suggestions.list_label', 'Suggestions')} tabIndex={-1} onKeyDown={onKeyDown}
            className={`flex flex-col min-h-0 bg-[var(--bg-secondary)] ${props.className || ''}`} data-testid="suggestions-panel">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-subtle)]">
                <h2 className="text-sm font-semibold text-[var(--text-primary)] flex-1">{t('suggestions.title', 'Suggestions')}</h2>
                {onClose && (
                    <button type="button" onClick={onClose} aria-label={t('common.close', 'Close')} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                        <X size={15} aria-hidden="true" />
                    </button>
                )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4">
                {!canEdit && all.length > 0 && <p className="text-xs text-[var(--text-tertiary)]" data-testid="suggestions-viewer-hint">{t('suggestions.viewer_hint', 'You can read these suggestions. Only people who can edit the page can accept or reject them.')}</p>}
                {notice && <Notice tone="warning">{notice}</Notice>}
                {body}
                {canEdit && order.length > 0 && <p className="text-[11px] text-[var(--text-tertiary)]">{t('suggestions.keyboard_hint', 'J and K move between suggestions, A accepts, R rejects.')}</p>}
            </div>
        </div>
    );
}
