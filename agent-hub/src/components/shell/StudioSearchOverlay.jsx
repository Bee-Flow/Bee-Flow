import { AlertTriangle, Search, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';
import { STUDIO_APPS } from '../admin/Studio/studioApps';
import { segmentForSection } from '../admin/Studio/studioRoutes';
import { kindColorVar } from '../shared/kindColors';
import Modal from '../shared/Modal';

/**
 * StudioSearchOverlay — name search across the nine Studio kinds, over
 * GET /api/studio/search (server/routes/studio/search.js).
 *
 * ITS OWN COMPONENT, not a mode on shell/SearchOverlay. That one searches
 * CONVERSATIONS: a different endpoint, different filters (agent, date range,
 * sort), a different result shape, its own recent-searches store — and about
 * twenty-five untranslated English literals that a second mode would have
 * dragged into this commit. Two searches that share a keystroke are not one
 * component.
 *
 * THE THING THIS SCREEN MUST NOT DO is answer "nothing found" when the truth
 * is "we could not look". The endpoint distinguishes three states and so does
 * this overlay:
 *
 *   errors: [...]  — some kinds could not be searched. The list still renders
 *                    (what DID answer is real) with a visible warning above
 *                    it, because a short list is only trustworthy if it says
 *                    it is short.
 *   request failed — nothing at all was searched. NO empty state, no "no
 *                    matches for": one line saying the search is unavailable.
 *   results empty  — the honest empty state.
 *
 * Not a lazy chunk: it is imported by the rail, which the sidebar renders on
 * every Studio page, and a search box that has to fetch its own code before it
 * can take a keystroke is the slowest kind of fast.
 */

const DEBOUNCE_MS = 250;
/** Mirrors MIN_QUERY_LENGTH in routes/studio/search.js. */
const MIN_QUERY_LENGTH = 2;

// The server names the nine kinds with the vocabulary GET /api/studio/counts
// uses. Every key IS a Studio section id except this one: the Automations
// section's id is 'aiTasks' (the key the whole navigation layer is written
// against) while its count/search key — and its URL — say 'automations'.
const SECTION_FOR_KIND = { automations: 'aiTasks' };
const sectionForKind = (kind) => SECTION_FOR_KIND[kind] || kind;

/** The registry descriptor behind a result group, or null for an unknown kind. */
const appForKind = (kind) => STUDIO_APPS.find((a) => a.id === sectionForKind(kind)) || null;

/** A section's label, whichever way its descriptor spells it. */
const labelOf = (app, t) => (app.labelFallback ? t(app.labelKey, app.labelFallback) : t(app.labelKey));

/** One short line of prose about the answer. At most one of them renders. */
function SearchStatus({ t, failed, partial, tooShort, loading, empty, query }) {
    if (failed) {
        return (
            <div className="flex items-start gap-2 px-3 py-3 text-[12px] text-[var(--text-secondary)]" data-testid="studio-search-failed">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-[var(--text-tertiary)]" strokeWidth={1.75} aria-hidden="true" />
                <span>{t('studio.search.failed', 'Search is unavailable right now — this is not an empty result.')}</span>
            </div>
        );
    }
    // Some kinds answered and some did not. The rows below are real; the list
    // is just not all of them, and saying so is the whole reason the endpoint
    // returns `errors`. It outranks the empty state: with every matching kind
    // in the failed set, "no matches" would be a claim about data nobody read.
    if (partial) {
        return (
            <div className="flex items-start gap-2 px-3 py-2 text-[12px] text-[var(--text-secondary)]" data-testid="studio-search-partial">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-[var(--text-tertiary)]" strokeWidth={1.75} aria-hidden="true" />
                <span>{t('studio.search.partial', 'Some sources could not be searched — this list may be incomplete.')}</span>
            </div>
        );
    }
    if (tooShort) {
        return (
            <div className="px-3 py-3 text-[12px] text-[var(--text-tertiary)]" data-testid="studio-search-min-chars">
                {t('studio.search.min_chars', 'Type at least two characters')}
            </div>
        );
    }
    if (loading) {
        return (
            <div className="px-3 py-3 text-[12px] text-[var(--text-tertiary)]" data-testid="studio-search-loading">
                {t('studio.search.loading', 'Searching…')}
            </div>
        );
    }
    if (empty) {
        return (
            <div className="px-3 py-3 text-[12px] text-[var(--text-tertiary)]" data-testid="studio-search-empty">
                {t('studio.search.empty', 'No matches for "{q}"', { q: query })}
            </div>
        );
    }
    return null;
}

/** One kind's hits, under its section heading, plus a way into the section. */
function ResultGroup({ t, group, activeIdx, setActiveIdx, openRow, openSection }) {
    const { kind, app, items, startIdx } = group;
    const Icon = app?.Icon;
    const color = app?.kind ? kindColorVar(app.kind) : 'var(--text-secondary)';
    return (
        <div className="mb-1">
            <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                {app ? labelOf(app, t) : kind}
            </div>
            {items.map((item, i) => {
                const idx = startIdx + i;
                return (
                    <button
                        key={`${kind}-${item.id}`}
                        type="button"
                        onClick={() => openRow({ ...item, kind })}
                        onMouseEnter={() => setActiveIdx(idx)}
                        aria-current={idx === activeIdx ? 'true' : undefined}
                        data-testid={`studio-search-hit-${kind}-${item.id}`}
                        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${idx === activeIdx ? 'bg-[var(--item-active-bg)]' : 'hover:bg-[var(--item-hover-bg)]'}`}
                    >
                        {Icon && <Icon className="w-4 h-4 flex-shrink-0" style={{ color }} strokeWidth={1.75} />}
                        <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--text-primary)]">{item.name}</span>
                    </button>
                );
            })}
            {app && (
                <button
                    type="button"
                    onClick={() => openSection(app)}
                    data-testid={`studio-search-all-${kind}`}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--item-hover-bg)]"
                >
                    <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                        {t('sidebar.recent_show_all', 'All {section}', { section: labelOf(app, t) })}
                    </span>
                </button>
            )}
        </div>
    );
}

/** The request half: debounce, out-of-order guard, and the three answers. */
function useStudioSearch(isOpen, trimmed) {
    // null = nothing asked yet. Never conflated with "asked, got nothing".
    const [answer, setAnswer] = useState(null);
    const [loading, setLoading] = useState(false);
    // Request-level failure: the whole search, not one kind of it.
    const [failed, setFailed] = useState(false);
    const requestSeq = useRef(0);

    useEffect(() => {
        if (!isOpen || trimmed.length < MIN_QUERY_LENGTH) {
            // Below the threshold the server would not look either, so do not
            // ask — and clear whatever the previous query answered rather than
            // leaving stale rows under a new word.
            requestSeq.current += 1;
            setAnswer(null);
            setFailed(false);
            setLoading(false);
            return undefined;
        }
        const seq = ++requestSeq.current;
        setLoading(true);
        const timer = setTimeout(async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/studio/search?q=${encodeURIComponent(trimmed)}`);
                if (seq !== requestSeq.current) return; // a newer keystroke won
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                if (seq !== requestSeq.current) return;
                setAnswer(body);
                setFailed(false);
            } catch {
                if (seq !== requestSeq.current) return;
                // NOT an empty answer. `answer` is cleared so no stale rows
                // survive, and `failed` makes the difference visible.
                setAnswer(null);
                setFailed(true);
            } finally {
                if (seq === requestSeq.current) setLoading(false);
            }
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [isOpen, trimmed]);

    return { answer, loading, failed };
}

export default function StudioSearchOverlay({ isOpen, onClose, onNavigate }) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [activeIdx, setActiveIdx] = useState(0);
    const inputRef = useRef(null);
    const trimmed = query.trim();
    const { answer, loading, failed } = useStudioSearch(isOpen, trimmed);

    useEffect(() => {
        if (!isOpen) { setQuery(''); setActiveIdx(0); return undefined; }
        const id = setTimeout(() => inputRef.current?.focus(), 30);
        return () => clearTimeout(id);
    }, [isOpen]);

    // The groups in registry order (so the overlay lists the kinds in the same
    // order the rail does), each carrying where its rows start in the flat
    // keyboard list.
    const groups = useMemo(() => {
        const results = answer?.results || {};
        const order = (kind) => {
            const idx = STUDIO_APPS.findIndex((a) => a.id === sectionForKind(kind));
            return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
        };
        return Object.keys(results)
            .map((kind) => ({ kind, app: appForKind(kind), items: results[kind] || [] }))
            .filter((g) => g.items.length > 0)
            .sort((a, b) => order(a.kind) - order(b.kind))
            // Where this group's rows start in the flat keyboard list. Nine
            // groups at most, so counting the ones before it is cheaper than
            // carrying a running total out of the callback.
            .map((g, i, arr) => ({ ...g, startIdx: arr.slice(0, i).reduce((n, x) => n + x.items.length, 0) }));
    }, [answer]);

    const flatRows = useMemo(
        () => groups.flatMap((g) => g.items.map((item) => ({ ...item, kind: g.kind }))),
        [groups],
    );

    const openRow = useCallback((row) => {
        if (!row) return;
        onClose?.();
        onNavigate?.(`studio/${segmentForSection(sectionForKind(row.kind))}/${row.id}`);
    }, [onClose, onNavigate]);

    const openSection = useCallback((app) => {
        onClose?.();
        onNavigate?.(`studio/${app.urlSegment}`);
    }, [onClose, onNavigate]);

    // Escape is Modal's job now (document-level listener below); handling it
    // here too would fire onClose twice.
    const onKeyDown = (e) => {
        if (!flatRows.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => (i + 1) % flatRows.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => (i - 1 + flatRows.length) % flatRows.length); }
        else if (e.key === 'Enter') { e.preventDefault(); openRow(flatRows[activeIdx]); }
    };

    if (!isOpen) return null;

    const partial = !failed && Array.isArray(answer?.errors) && answer.errors.length > 0;
    const tooShort = trimmed.length < MIN_QUERY_LENGTH;
    const searched = !!answer && !answer.tooShort;

    return (
        <Modal
            open
            onClose={() => onClose?.()}
            placement="top"
            variant="bare"
            size="auto"
            zIndex={60}
            label={t('studio.search.title', 'Search Studio')}
            className="max-w-xl"
            data-testid="studio-search-overlay"
        >
            <div
                className="relative w-full rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden"
                style={{ boxShadow: 'var(--shadow-popover, 0 20px 60px rgba(15,23,42,0.18))' }}
                data-surface="opaque"
                onKeyDown={onKeyDown}
            >
                <div className="flex items-center gap-2.5 px-4 h-14 border-b border-[var(--border-subtle)]">
                    <Search className="w-4 h-4 flex-shrink-0 text-[var(--text-tertiary)]" strokeWidth={1.75} />
                    <input
                        ref={inputRef}
                        value={query}
                        // The highlight resets with the WORD, in the event
                        // handler — not in an effect on the answer, which
                        // would be a second render per keystroke.
                        onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
                        placeholder={t('studio.search.placeholder', 'Search Studio…')}
                        aria-label={t('studio.search.placeholder', 'Search Studio…')}
                        data-testid="studio-search-input"
                        className="flex-1 bg-transparent outline-none text-[14px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                    />
                    <button
                        type="button"
                        onClick={() => onClose?.()}
                        aria-label={t('studio.search.close', 'Close search')}
                        data-testid="studio-search-close"
                        className="p-1.5 rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)]"
                    >
                        <X className="w-4 h-4" strokeWidth={1.75} />
                    </button>
                </div>

                <div className="max-h-[60vh] overflow-y-auto custom-scrollbar p-1.5">
                    <SearchStatus
                        t={t}
                        failed={failed}
                        partial={partial}
                        tooShort={tooShort && !failed}
                        loading={!tooShort && loading && !answer && !failed}
                        empty={searched && flatRows.length === 0}
                        query={trimmed}
                    />
                    {groups.map((group) => (
                        <ResultGroup
                            key={group.kind}
                            t={t}
                            group={group}
                            activeIdx={activeIdx}
                            setActiveIdx={setActiveIdx}
                            openRow={openRow}
                            openSection={openSection}
                        />
                    ))}
                </div>
            </div>
        </Modal>
    );
}
