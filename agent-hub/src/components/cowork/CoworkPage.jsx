/**
 * /app/cowork — everything you handed to Bee Flow, in one place.
 *
 * This page replaces two half-surfaces. The sidebar's "Work" page could create
 * items and pause them but never showed a run history or let you fix a
 * schedule the composer had inferred wrong; Studio → Cowork could do both but
 * sat three clicks away under a different word, and had no way to make
 * anything. Splitting "create" from "correct" across two screens is what made
 * the feature feel like several features.
 *
 * Left column: the composer, then the list. Right pane: the selected item with
 * its full history — or, when nothing is selected, the welcome that used to be
 * the whole page. Deep-linkable at /app/cowork/:id.
 */
import { CalendarClock, Plus, RefreshCw, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useModelTierSelection from '../../hooks/useModelTierSelection';
import useTranslation from '../../hooks/useTranslation';
import Modal from '../shared/Modal';
import CoworkComposer from './CoworkComposer';
import CoworkDetail from './CoworkDetail';
import CoworkRow from './CoworkRow';
import { CoworkWelcomeHeader, COWORK_STARTER_ITEMS } from './CoworkWelcome';
import {
    deleteCowork, listCowork, listCoworkAgents, runCoworkNow, toggleCowork, updateCowork,
} from './coworkApi';
import { isInFlight } from './coworkStatus';
import useCoworkComposer from './useCoworkComposer';

export default function CoworkPage({ user = null, isMobile = false, initialCoworkId = null, onNavigate }) {
    const { t } = useTranslation();
    const [items, setItems] = useState([]);
    const [maxItems, setMaxItems] = useState(10);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [brief, setBrief] = useState('');
    const [busy, setBusy] = useState(false);
    const [selectedId, setSelectedId] = useState(initialCoworkId);
    const [editingId, setEditingId] = useState(null);
    const [pendingDelete, setPendingDelete] = useState(null);
    const [flash, setFlash] = useState(null);
    // Bumped after any mutation so an open history refetches without a reload.
    const [reloadKey, setReloadKey] = useState(0);
    const [agents, setAgents] = useState([]);
    const textareaRef = useRef(null);

    const refresh = useCallback(async () => {
        try {
            const { items: list, maxItems: max } = await listCowork();
            setItems(list);
            setMaxItems(max);
            setLoadError(null);
        } catch (err) {
            setLoadError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    // Only the edit form's "Run as" picker needs these; an empty list simply
    // hides the field, which is the right outcome outside the agent beta.
    useEffect(() => {
        let cancelled = false;
        listCoworkAgents()
            .then(list => { if (!cancelled) setAgents(list); })
            .catch(() => { if (!cancelled) setAgents([]); });
        return () => { cancelled = true; };
    }, []);

    // A deep link wins on arrival; after that the user's clicks decide.
    useEffect(() => {
        if (initialCoworkId) setSelectedId(initialCoworkId);
    }, [initialCoworkId]);

    const cowork = useCoworkComposer({
        onCreated: (created, payload) => {
            setBrief('');
            setFlash(payload.startNow ? 'Off it goes — the result lands in your notifications.' : 'Scheduled.');
            // Select what was just created, so the history it is about to fill
            // is already on screen.
            if (created?.id) setSelectedId(created.id);
            refresh();
        },
    });

    useEffect(() => {
        if (!flash) return undefined;
        const t = setTimeout(() => setFlash(null), 4000);
        return () => clearTimeout(t);
    }, [flash]);

    // Cowork keeps its own remembered tier, separate from the chat's: a daily
    // digest and a conversation are different jobs and deserve different
    // budgets. Until this existed the page sent no tier at all, so everything
    // scheduled here silently ran on 'auto'.
    const { modelTiers, selectedTier, setSelectedTier } = useModelTierSelection({
        storageKey: 'coworkTier',
    });

    const atLimit = items.length >= maxItems;
    const send = () => {
        if (atLimit) return;
        cowork.submit(brief, { modelTier: selectedTier });
    };

    // ONE count, from ONE predicate. The header pill, the poll below and the
    // sidebar badge are the same question — "is anything on the go, and how
    // much of it" — and the moment two of them derive it their own way they
    // drift: the badge used to count `isActive`, so six schedules with two
    // running showed a 5 (CW-02/CW-18).
    const inFlightCount = useMemo(() => items.filter(isInFlight).length, [items]);

    // Results arrive asynchronously (the runner reports into notifications),
    // so poll gently while something is mid-run rather than leaving the page
    // showing "Starting…" until the user reloads. Stops as soon as it settles.
    const anyInFlight = inFlightCount > 0;
    useEffect(() => {
        if (!anyInFlight) return undefined;
        const t = setInterval(refresh, 10_000);
        return () => clearInterval(t);
    }, [anyInFlight, refresh]);

    const selected = useMemo(
        () => items.find(i => i.id === selectedId) || null,
        [items, selectedId],
    );

    const select = useCallback((id) => {
        setSelectedId(id);
        // Switching rows abandons an open edit: carrying the form over to a
        // different item would save one item's text onto another.
        setEditingId(null);
        setActionError(null);
        if (onNavigate) onNavigate(`cowork/${id}`);
    }, [onNavigate]);

    const withBusy = useCallback(async (fn) => {
        setBusy(true);
        setActionError(null);
        try {
            await fn();
            await refresh();
            setReloadKey(k => k + 1);
        } catch (err) {
            setActionError(err.message);
        } finally {
            setBusy(false);
        }
    }, [refresh]);

    const handleRunNow = useCallback((id) => withBusy(async () => {
        await runCoworkNow(id);
        setFlash('Running — the result lands in your notifications.');
    }), [withBusy]);

    const handleToggle = useCallback((id) => withBusy(() => toggleCowork(id)), [withBusy]);

    const handleDelete = useCallback(async () => {
        const item = pendingDelete;
        setPendingDelete(null);
        if (!item) return;
        await withBusy(async () => {
            await deleteCowork(item.id);
            setSelectedId(prev => (prev === item.id ? null : prev));
        });
    }, [pendingDelete, withBusy]);

    const handleSave = useCallback(async (patch) => {
        if (!selectedId) return;
        setBusy(true);
        setActionError(null);
        try {
            await updateCowork(selectedId, patch);
            // Leave edit mode only on success, so a rejected save keeps the
            // user's edits on screen instead of discarding them.
            setEditingId(null);
            await refresh();
        } catch (err) {
            setActionError(err.message);
        } finally {
            setBusy(false);
        }
    }, [selectedId, refresh]);

    // ── Composer ────────────────────────────────────────────
    // Lives in the wide right-hand pane, directly under the promise it answers
    // — not in the 320px list column, where the chips wrapped onto three rows
    // and the brief was two words per line.
    const composer = (
        <>
            <CoworkComposer
                value={brief}
                onChange={setBrief}
                onSubmit={send}
                cowork={cowork}
                modelTiers={modelTiers}
                selectedTier={selectedTier}
                onTierChange={setSelectedTier}
                simpleMode={!!user?.simpleMode || isMobile}
                isMobile={isMobile}
                // Under a full-height hero a single-line box reads as an
                // afterthought; in the chat the same component starts at one
                // row and grows. Two, not three — a brief is usually a
                // sentence, and an empty box the size of a paragraph reads as
                // a demand for one.
                minRows={2}
                textareaRef={textareaRef}
            />

            {/* Page-level status: the load error, the "off it goes" flash and
                the quota ceiling. The composer shows its own create errors.
                This is also the only place the quota is spelled out — a
                permanent "4/10 in use" under the box was noise nine times out
                of ten, and the tenth time it needs to be a warning anyway. */}
            {(flash || loadError || atLimit) && (
                <div
                    className="mt-3 rounded-xl px-3 py-2 text-[12px]"
                    role="status"
                    style={{
                        background: 'var(--bg-secondary)',
                        color: loadError ? 'var(--danger, #dc2626)' : 'var(--text-secondary)',
                    }}
                >
                    {loadError || flash
                        || `You've used all ${maxItems} cowork slots. Delete or finish one to add more.`}
                </div>
            )}
        </>
    );

    // ── List ────────────────────────────────────────────────
    // One flat list, in the order the server sent it (newest first).
    //
    // It used to be two sections, "Running & scheduled" over "Done & paused",
    // and those headings were doing the row's job: the status was a small
    // coloured icon with no word, so the only way to learn that something had
    // stopped was which heading it had drifted under. Now that every row says
    // "Running" / "Paused" / "Failed" out loud (CW-03), the split costs more
    // than it gives — it reorders the list out from under someone the moment
    // an item finishes, and it hides the newest thing they made under a
    // heading two screens down.
    const rows = items.map(item => (
        <CoworkRow
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            onSelect={select}
        />
    ));

    // The dotted card under the rows. It states the ONE thing this screen
    // cannot show — where Cowork stops and the Builder starts — and it is
    // there whether the list is empty or full (CW-05). The old copy only
    // appeared at zero items, so the boundary was explained exactly once, to
    // someone who had not yet met either side of it.
    const explainer = (
        <p
            data-testid="cowork-explainer"
            className="mt-3 mx-1 px-3 py-2.5 rounded-[9px] border border-dashed text-[11px] leading-relaxed"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
        >
            {t(
                'cowork.list.explainer',
                'Cowork is the short way: you write down what needs to happen, not how. If it has to take more steps, the same brief opens in the Builder.',
            )}
        </p>
    );

    // Phones get one pane at a time: the composer and the list stacked in a
    // single scroll, or — once a row is tapped — the detail on its own. The
    // desktop split would put a 320px column next to a 40px one.
    const showList = !isMobile || !selected;
    const showPane = !isMobile || !!selected;

    return (
        <div className="flex-1 flex min-h-0 min-w-0" style={{ background: 'var(--bg-primary)' }}>
            {showList && (
            <aside
                className={`${isMobile ? 'flex-1' : 'w-80 flex-shrink-0 border-r'} flex flex-col min-h-0`}
                style={{ borderColor: 'var(--border-subtle)' }}
            >
                <div className="flex items-center gap-2 px-3 py-2.5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Cowork</span>
                    {/* The tally, and only when there is one to tell. A
                        permanent "0 running" is a fact nobody asked for; the
                        pill exists to be noticed. */}
                    {inFlightCount > 0 && (
                        <span
                            data-testid="cowork-running-count"
                            className="px-1.5 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0"
                            style={{
                                background: 'color-mix(in srgb, var(--type-ai) 14%, transparent)',
                                color: 'var(--type-ai)',
                            }}
                        >
                            {t('cowork.list.running_count', '{count} running', { count: inFlightCount })}
                        </span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                        <button
                            type="button"
                            onClick={refresh}
                            disabled={loading || busy}
                            aria-label={t('cowork.list.refresh', 'Refresh')}
                            data-testid="cowork-refresh"
                            className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                            style={{ color: 'var(--text-tertiary)' }}
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                        </button>
                        {/* The one filled button on this column, and the thing
                            the screen is for. Clearing the selection is what
                            brings the composer back — it lives in the pane on
                            the right, so this button reveals it rather than
                            opening anything of its own. */}
                        <button
                            type="button"
                            onClick={() => { setSelectedId(null); setEditingId(null); textareaRef.current?.focus(); }}
                            disabled={busy}
                            data-testid="cowork-new"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] font-semibold disabled:opacity-50"
                            style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                        >
                            <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                            {t('cowork.list.new', 'New task')}
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-3 pt-1">
                    {/* On a phone there is no second pane to put the composer
                        in, so it rides above the list instead. */}
                    {isMobile && (
                        <div className="px-1 pt-2 pb-1">
                            <CoworkWelcomeHeader className="text-center mb-4" />
                            {composer}
                        </div>
                    )}
                    {loading && items.length === 0 && (
                        <p className="px-2 pt-3 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                            {t('cowork.list.loading', 'Loading…')}
                        </p>
                    )}
                    <div className="flex flex-col gap-0.5 pt-1">{rows}</div>
                    {explainer}
                </div>
            </aside>
            )}

            {showPane && (
                <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                    {actionError && editingId === null && (
                        <p className="m-4 text-[12px] text-red-600 dark:text-red-400" role="alert">{actionError}</p>
                    )}
                    {selected ? (
                        <CoworkDetail
                            item={selected}
                            agents={agents}
                            onRunNow={handleRunNow}
                            onToggle={handleToggle}
                            onDelete={setPendingDelete}
                            onSave={handleSave}
                            editing={editingId === selected.id}
                            onEdit={() => { setActionError(null); setEditingId(selected.id); }}
                            onCancelEdit={() => { setActionError(null); setEditingId(null); }}
                            saveError={actionError}
                            busy={busy}
                            reloadKey={reloadKey}
                        />
                    ) : (
                        <div className="h-full overflow-y-auto custom-scrollbar flex flex-col items-center justify-center px-6 py-10">
                            <div className="w-full max-w-2xl">
                                <CoworkWelcomeHeader />
                                {composer}

                                {/* Starters only while there is nothing real to
                                    look at — otherwise they compete with the
                                    user's own work for attention. */}
                                {items.length === 0 ? (
                                    <div className="mt-5 flex flex-col gap-2">
                                        {/* The keyed table, not the flattened
                                            COWORK_STARTERS strings: those drop
                                            the keys, so this page printed the
                                            English while the chat welcome —
                                            same four sentences, same file —
                                            showed the translation. */}
                                        {COWORK_STARTER_ITEMS.map(({ key, en }) => {
                                            const text = t(key, en);
                                            return (
                                            <button
                                                key={key}
                                                type="button"
                                                onClick={() => { setBrief(text); textareaRef.current?.focus(); }}
                                                data-testid="cowork-starter"
                                                className="text-left px-3.5 py-2.5 rounded-xl border text-[12.5px] transition-colors hover:bg-[var(--bg-secondary)]"
                                                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                            >
                                                {text}
                                            </button>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <p className="mt-6 text-[13px] flex items-center gap-2 justify-center" style={{ color: 'var(--text-tertiary)' }}>
                                        <CalendarClock className="w-4 h-4 flex-shrink-0" />
                                        Or pick something on the left to see when it runs and how every run went.
                                    </p>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Delete confirm ──────────────────────────────────── */}
            {pendingDelete && (
                <Modal
                    open
                    onClose={() => setPendingDelete(null)}
                    variant="bare"
                    size="auto"
                    zIndex={1000}
                    label={t('cowork.delete.heading', 'Delete this cowork?')}
                >
                    <div
                        className="w-full max-w-sm rounded-2xl border shadow-2xl p-5"
                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)' }}
                    >
                        <div className="text-[14px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                            {t('cowork.delete.heading', 'Delete this cowork?')}
                        </div>
                        {/* The title travels as a PARAMETER, not as a child
                            between two JSX fragments: a translator has to be
                            able to move it inside the sentence, and half a
                            sentence either side of a name is not translatable
                            at all in most languages. */}
                        <p className="text-[12.5px] mb-4" style={{ color: 'var(--text-secondary)' }}>
                            {t(
                                'cowork.delete.consequence',
                                '“{title}” stops running and its history is removed. This can’t be undone.',
                                { title: pendingDelete.title },
                            )}
                        </p>
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => setPendingDelete(null)}
                                className="px-3.5 py-2 rounded-lg text-[12.5px] font-medium hover:bg-[var(--bg-tertiary)]"
                                style={{ color: 'var(--text-secondary)' }}
                            >
                                {t('cowork.delete.cancel', 'Cancel')}
                            </button>
                            <button
                                onClick={handleDelete}
                                data-testid="cowork-confirm-delete"
                                className="px-3.5 py-2 rounded-lg text-[12.5px] font-semibold text-white bg-red-500 hover:bg-red-600"
                            >
                                {t('cowork.delete.confirm', 'Delete')}
                            </button>
                        </div>
                    </div>
                </Modal>
            )}

            {/* Phones: a selected item takes the whole screen, so it needs a way back. */}
            {isMobile && selected && (
                <button
                    type="button"
                    onClick={() => { setSelectedId(null); setEditingId(null); }}
                    aria-label={t('cowork.list.back', 'Back to the list')}
                    className="fixed top-3 right-3 z-[900] p-2 rounded-full border shadow-sm"
                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                    <X className="w-4 h-4" />
                </button>
            )}
        </div>
    );
}
