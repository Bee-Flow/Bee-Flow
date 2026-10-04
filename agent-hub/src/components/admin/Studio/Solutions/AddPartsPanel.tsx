import { Loader2, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import AddKindList, { keyOf } from './AddKindList';
import AddKindTiles from './AddKindTiles';
import AddResult from './AddResult';
import {
    ADDABLE, loadKind, loadSolutionNames, type AddItem, type KindLoad,
} from './addPartsSources';
import { comingAlong, useRelatedParts, type RelatedRef } from './relatedParts';
import RelatedPartsNotice from './RelatedPartsNotice';
import { useAddFiling } from './useAddFiling';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * "Add to this Solution": file things you already made into it.
 *
 * Kind tiles with a count, a search box, a checklist and one "Add N" button.
 * Every listing is read once when the panel opens, so the counts on the tiles
 * are real before anyone clicks. Four states stay apart, because they send
 * someone to four different places: still loading, could not be read (retry),
 * read and empty ("nothing of yours left"), and read but filtered away by the
 * search. A failure while filing is told per item in the server's own words;
 * the items that did go in leave the list.
 */

export interface AddPartsPanelProps {
    projectId: string;
    /** `${kind}:${id}` of everything already in this Solution. */
    alreadyIn: Set<string>;
    currentUserId?: string | null;
    onAdded?: () => void;
    onClose?: () => void;
    /** `card` sits on the page; `drawer` fills a sheet that brings its own header. */
    variant?: 'card' | 'drawer';
    /** The kind tab that is open first, e.g. the tile picked on the empty screen. */
    initialKind?: string | null;
}

/**
 * Reads every listing once. The inputs are a snapshot taken when the panel
 * opens: the parent builds `alreadyIn` anew on every render, and a read keyed on
 * it would loop. What gets filed afterwards leaves the lists through `drop`.
 */
function useAddLoads(projectId: string, alreadyIn: Set<string>, me: string | null | undefined) {
    const [ctx] = useState(() => ({ projectId, alreadyIn, me }));
    const [loads, setLoads] = useState<Record<string, KindLoad>>({});
    const [names, setNames] = useState<Map<string, string>>(new Map());

    const load = useCallback(async (kind: string) => {
        setLoads(prev => ({ ...prev, [kind]: { status: 'loading' } }));
        const result = await loadKind(kind, ctx);
        setLoads(prev => ({ ...prev, [kind]: result }));
    }, [ctx]);

    useEffect(() => {
        let alive = true;
        ADDABLE.forEach(s => { void load(s.kind); });
        void loadSolutionNames().then(map => { if (alive) setNames(map); });
        return () => { alive = false; };
    }, [load]);

    const drop = useCallback((keys: Set<string>) => {
        setLoads(prev => {
            const next: Record<string, KindLoad> = {};
            for (const [kind, l] of Object.entries(prev)) {
                next[kind] = l.status === 'ok' ? { status: 'ok', items: l.items.filter(i => !keys.has(keyOf(i))) } : l;
            }
            return next;
        });
    }, []);

    return { loads, names, reload: load, drop };
}

/** What the ticked parts need, asked a moment after the ticking settles. */
function useSelectionRelated(projectId: string, loads: Record<string, KindLoad>, picked: Set<string>) {
    const chosen = useMemo<RelatedRef[]>(() => {
        const out: RelatedRef[] = [];
        for (const l of Object.values(loads)) {
            if (l.status === 'ok') out.push(...l.items.filter(i => picked.has(keyOf(i))).map(i => ({ kind: i.kind, id: i.id })));
        }
        return out;
    }, [loads, picked]);
    const related = useRelatedParts(projectId, chosen);
    return { related, alongCount: comingAlong(related).length };
}

function SubmitButton({ picked, along, busy, checking, onClick }: { picked: number; along: number; busy: boolean; checking: boolean; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            disabled={picked === 0 || busy || checking}
            onClick={onClick}
            data-testid="add-parts-submit"
            className="inline-flex items-center justify-center gap-1.5 h-11 sm:h-10 px-4 rounded-[var(--radius-sm)] text-[13px] font-medium disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2"
        >
            {busy && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {along > 0
                ? t('solutions.add_n_related', 'Add {count} (+{related} related)', { count: picked, related: along })
                : t('solutions.add_n', 'Add {count}', { count: picked })}
        </button>
    );
}

function PanelFooter({ drawer, onClose, children }: { drawer: boolean; onClose?: () => void; children: React.ReactNode }) {
    const { t } = useTranslation();
    return (
        <div className={`sticky bottom-0 py-3 flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] ${drawer ? '-mx-5 -mb-4 px-5 bg-[var(--bg-secondary)]' : '-mx-4 lg:-mx-5 -mb-4 lg:-mb-5 px-4 lg:px-5 bg-[var(--bg-card)] rounded-b-[var(--radius-lg)]'}`}>
                {onClose && (
                    <button type="button" onClick={onClose} data-testid="add-parts-cancel"
                            className="inline-flex items-center h-11 sm:h-10 px-4 rounded-[var(--radius-sm)] text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                        {t('common.cancel', 'Cancel')}
                    </button>
                )}
            {children}
        </div>
    );
}

export default function AddPartsPanel({ projectId, alreadyIn, currentUserId, onAdded, onClose, variant = 'card', initialKind = null }: AddPartsPanelProps) {
    const drawer = variant === 'drawer';
    const { t } = useTranslation();
    const { loads, names, reload, drop } = useAddLoads(projectId, alreadyIn, currentUserId);
    const [kind, setKind] = useState<string | null>(initialKind);
    const [query, setQuery] = useState('');
    const [picked, setPicked] = useState<Set<string>>(new Set());

    // Until someone chooses, the first kind with something free to add is open;
    // failing that, the first with anything at all (so what sits in another
    // Solution is still seen rather than hidden behind an empty tile).
    const hasItems = (kind: string, free: boolean) => {
        const l = loads[kind];
        return !!l && l.status === 'ok' && l.items.some(i => !free || i.inProjectId === null);
    };
    const firstFree = (ADDABLE.find(s => hasItems(s.kind, true)) ?? ADDABLE.find(s => hasItems(s.kind, false)))?.kind ?? null;
    const activeKind = kind ?? firstFree;
    const load = activeKind ? loads[activeKind] : undefined;

    const toggle = (item: AddItem) => setPicked(prev => {
        const next = new Set(prev);
        if (!next.delete(keyOf(item))) next.add(keyOf(item));
        return next;
    });

    const { related, alongCount } = useSelectionRelated(projectId, loads, picked);

    const { add, busy, outcome } = useAddFiling({ projectId, loads, picked, related, setPicked, drop, onAdded });

    return (
        <section className={drawer ? 'space-y-4' : 'rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 lg:p-5 space-y-4'} data-testid="add-parts-panel">
            {!drawer && <header className="flex items-center gap-2">
                <h3 className="flex-1 text-[15px] font-semibold text-[var(--text-primary)]">{t('solutions.add_panel_title', 'Add to this Solution')}</h3>
                {onClose && (
                    <button type="button" onClick={onClose} aria-label={t('solutions.add_panel_close', 'Close')} data-testid="add-parts-close"
                            className="inline-flex items-center justify-center w-10 h-10 -m-2 rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                        <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                )}
            </header>}

            <AddKindTiles loads={loads} active={activeKind} onPick={(k) => { setKind(k); setQuery(''); }} />

            {activeKind && (
                <AddKindList
                    load={load}
                    query={query}
                    onQuery={setQuery}
                    names={names}
                    picked={picked}
                    busy={busy}
                    onToggle={toggle}
                    onRetry={() => void reload(activeKind)}
                />
            )}

            {!activeKind && Object.keys(loads).length > 0 && ADDABLE.every(s => loads[s.kind]?.status !== 'loading') && (
                <p className="px-3 py-2 rounded-[var(--radius-md)] text-xs bg-[var(--bg-secondary)] text-[var(--text-secondary)]" data-testid="add-parts-nothing-anywhere">
                    {t('solutions.add_nothing_anywhere', 'There is nothing of yours to add yet. Build something in Studio first, then come back.')}
                </p>
            )}

            {picked.size > 0 && <RelatedPartsNotice state={related} onRetry={related.retry} />}

            {outcome && <AddResult outcome={outcome} />}

            <PanelFooter drawer={drawer} onClose={onClose}>
                <SubmitButton picked={picked.size} along={alongCount} busy={busy} checking={related.status === 'loading'} onClick={() => void add()} />
            </PanelFooter>
        </section>
    );
}
