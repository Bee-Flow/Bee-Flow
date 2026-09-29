// Undo/redo wiring of the ProductWebsitePanel container — moved verbatim
// from ProductWebsitePanel.jsx. State stays owned by the panel; this hook
// groups the history composite, its synchronous mirrors and the hotkeys.
/* eslint-disable react-hooks/preserve-manual-memoization -- verbatim move
   out of ProductWebsitePanel.jsx: the React Compiler lint can no longer see
   that the threaded panel refs/setters are stable, so it reports advisory
   "compilation skipped" notes; the dep arrays are unchanged from the
   original component. */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import useDraftHistory from '../../../../hooks/useDraftHistory';

const docChanged = (a, b) => {
    if (a === b) return false;
    try { return JSON.stringify(a) !== JSON.stringify(b); } catch { return true; }
};

export default function useCmsHistory({
    site, pages, activeLocale, translationMode,
    aiRunningRef, builderRunningRef, disarmBuilderUndo, scheduleSave,
    setSiteDoc, setPages,
}) {
    // ── undo / redo ──────────────────────────────────────────────────
    //
    // History composite = { site, pages } ONLY. Locale overrides are
    // deliberately excluded (they interact with the aiRunningRef clobber
    // guard and the D1/D3/D4 deferred issues) — entering translate mode is
    // a reset barrier instead. Undoing a block delete therefore restores
    // the block but NOT its pruned translations (they fall back to source).
    //
    // Every content mutator routes through history.commit(next), whose
    // `apply` performs the setState + the SAME per-key scheduleSave the
    // mutators used to call directly — so undo/redo ride the normal 800ms
    // autosave pipeline (drain discipline, failedSaves retry, activeSiteIdRef
    // all unchanged). Barriers (history.reset): site load/switch, page CRUD
    // round-trips, reloadPayload, locale switch, import.

    // Synchronous mirrors so consecutive commits in one tick never read a
    // stale snapshot (state refs update in effects, AFTER render).
    const siteStateRef  = useRef(null);
    const pagesStateRef = useRef([]);
    useEffect(() => { siteStateRef.current = site; }, [site]);
    useEffect(() => { pagesStateRef.current = pages; }, [pages]);

    const applyHistoryDraft = useCallback((next) => {
        if (!next) return;
        // Never write while an AI translate folds results in — same rule as
        // the manual override mutators. Same for AI builder turns (the UI is
        // scrimmed; this is the belt-and-braces backstop).
        if (aiRunningRef.current || builderRunningRef.current) return;
        // Any human edit (or undo/redo) after an AI turn disarms "Undo turn" —
        // the server-side revert would clobber the newer human work.
        disarmBuilderUndo();
        const prevPages = pagesStateRef.current || [];
        if (next.site && docChanged(siteStateRef.current, next.site)) {
            siteStateRef.current = next.site;
            setSiteDoc(next.site);
            scheduleSave('site', next.site);
        }
        if (Array.isArray(next.pages)) {
            const prevById = new Map(prevPages.map(p => [p.id, p]));
            for (const p of next.pages) {
                const old = prevById.get(p.id);
                if (docChanged(old, p)) scheduleSave(p.id, p);
            }
            pagesStateRef.current = next.pages;
            setPages(next.pages);
        }
    }, [scheduleSave, disarmBuilderUndo, aiRunningRef, builderRunningRef, setPages, setSiteDoc]);

    const historyDraft = useMemo(() => ({ site, pages }), [site, pages]);
    const history = useDraftHistory({ currentDraft: historyDraft, apply: applyHistoryDraft });
    // Stable ref for reset-barrier callsites with empty dep arrays.
    const historyResetRef = useRef(history.reset);
    useEffect(() => { historyResetRef.current = history.reset; }, [history.reset]);

    // Locale switch = barrier (translate-mode edits live outside the composite).
    useEffect(() => { historyResetRef.current(); }, [activeLocale]);

    // Guarded undo/redo executor — shared by the window hotkey listener
    // below and the iframe-forwarded 'cms-hotkey' messages (the preview
    // iframe posts them because key events never bubble cross-document).
    // Skipped in translate mode (history only tracks the default-locale
    // composite) and during an AI translate. Returns whether it ran so the
    // window listener only preventDefaults when the hotkey was consumed.
    const undoHistory = history.undo;
    const redoHistory = history.redo;
    const runHistoryHotkey = useCallback((action) => {
        if (translationMode || aiRunningRef.current) return false;
        if (action === 'redo') redoHistory();
        else undoHistory();
        return true;
    }, [undoHistory, redoHistory, translationMode, aiRunningRef]);

    // Undo/redo hotkeys — skipped inside text inputs (native field undo
    // wins; the iframe side does its own equivalent target check before
    // forwarding).
    useEffect(() => {
        const onKey = (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const k = (e.key || '').toLowerCase();
            if (k !== 'z' && k !== 'y') return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            if (runHistoryHotkey((k === 'y' || (k === 'z' && e.shiftKey)) ? 'redo' : 'undo')) {
                e.preventDefault();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [runHistoryHotkey]);

    return { siteStateRef, pagesStateRef, history, historyResetRef, runHistoryHotkey };
}
