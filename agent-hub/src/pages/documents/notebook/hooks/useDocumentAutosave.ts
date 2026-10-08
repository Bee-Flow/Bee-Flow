/**
 * useDocumentAutosave — owns the editor document content + save lifecycle of
 * a notebook that is NOT being co-edited.
 *
 * Every save is a compare-and-set write (`expectedVersion`), including the
 * last one when the user leaves the notebook or closes the tab: a stale copy
 * never overwrites a newer save by a colleague, another tab or the AI. When a
 * save loses such a race the server keeps the losing copy as a 'conflict'
 * version and answers 409; this hook then PAUSES saving (so the editor does
 * not pile up more conflict copies) and hands the page what it needs to let
 * the user compare and choose — nothing is reloaded behind their back.
 *
 *   entityId        notebook id (null → saves no-op)
 *   initialVersion  server version to seed the CAS counter with; when omitted
 *                   the first PUT saves unconditionally and the counter
 *                   self-seeds from the response
 *   onConflict      the save lost a race: { localHtml, conflictVersionId, currentVersion }
 *   onCollabActive  the notebook is co-edited right now (409 COLLAB_ACTIVE):
 *                   the page should join the live session; the text that was
 *                   not saved is kept as a version (its id is passed). Saving
 *                   then WAITS (typing is kept pending) until the page calls
 *                   `resumeSaving`: once joined, or when the notebook turns
 *                   out not to be co-edited after all. A join that fails must
 *                   not turn every pause in typing into another refused save
 *                   and another copy in the history. Text typed while waiting
 *                   is kept as a version when the session takes over.
 *                   It returns false when the page will NOT join (this person
 *                   cannot): nothing would ever end that wait, so saving goes
 *                   on. Each refused save is kept as a version by the server,
 *                   and saves land again once the notebook is not co-edited.
 *   initialContent  the document as the notebook opened
 *   bound           the editor is bound to a live co-editing session: this
 *                   hook saves nothing (the session is the save)
 *   readOnly        the caller may not change the notebook: saves no-op
 *
 * One save at a time: a save that starts while another is in flight would
 * carry the same `expectedVersion` and conflict with this user's OWN save. The
 * newest text waits and goes as soon as the one in flight has landed.
 *
 * Returns the document state plus `editorRef` (the single editor ref owner),
 * `retrySave` for the header's "Save failed — retry" affordance,
 * `setKnownVersion` to resync the CAS counter from out-of-band sources (AI
 * edits, restores) and `resolveConflict` to resume saving after the user chose.
 */
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { notebookApi } from './notebookApi';

export type SaveState = 'idle' | 'saving' | 'error' | 'conflict';

export interface ConflictInfo {
    notebookId: string;
    /** The text that was not saved (the server kept it as a version too). */
    localHtml: string;
    conflictVersionId: string | null;
    currentVersion: number | null;
}

export interface AutosaveEditorHandle {
    setContent?: (html: string) => void;
    flush?: () => string | null;
    getEditor?: () => { getHTML?: () => string } | null;
    [key: string]: unknown;
}

interface Options {
    entityId?: string | null;
    initialVersion?: number | null;
    initialContent?: string;
    onConflict?: (info: ConflictInfo) => void;
    /** False: the page will not join, so saving must not wait for it. */
    onCollabActive?: (keptVersionId: string | null) => boolean | void;
    bound?: boolean;
    readOnly?: boolean;
}

interface RefusalDetails { conflictVersionId?: string | null; currentVersion?: number | null }

interface SaveError extends Error {
    status?: number;
    body?: { code?: string; details?: RefusalDetails };
}

/** How the hook answers a refused save. */
function refusalOf(e: SaveError): 'collab' | 'conflict' | 'permission' | 'other' {
    if (e.status === 409 && e.body?.code === 'COLLAB_ACTIVE') return 'collab';
    if (e.status === 409) return 'conflict';
    if (e.status === 401 || e.status === 403) return 'permission';
    return 'other';
}

/** One whole-document save, compare-and-set when a version is known. */
function putDocument(id: string, html: string, version: number | null) {
    const body: { documentContent: string; expectedVersion?: number } = { documentContent: html };
    if (version != null) body.expectedVersion = version;
    return notebookApi(`/${id}`, { method: 'PUT', body: JSON.stringify(body) }) as Promise<{ version?: number } | null>;
}

/** Keep text that will not be saved as a version (the server's 'conflict' copy), before it leaves the editor. */
export function keepUnsavedCopy(id: string, html: string): Promise<{ version?: { id?: string } } | null> {
    return notebookApi(`/${id}/versions/kept`, { method: 'POST', body: JSON.stringify({ html }) }) as Promise<{ version?: { id?: string } } | null>;
}

export default function useDocumentAutosave({
    entityId, initialVersion, initialContent = '', onConflict, onCollabActive, bound = false, readOnly = false,
}: Options = {}) {
    const [documentContent, setDocumentContent] = useState(initialContent);
    const [docSaving, setDocSaving] = useState(false);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
    const pendingContentRef = useRef<string | null>(null);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const editorRef = useRef<AutosaveEditorHandle | null>(null);
    const entityIdRef = useRef(entityId);
    // Last version this client knows the server holds. null = unknown → PUT
    // without expectedVersion (only until the first answer seeds it).
    const versionRef = useRef<number | null>(initialVersion ?? null);
    const initialVersionRef = useRef<number | null>(initialVersion ?? null);
    const onConflictRef = useRef(onConflict);
    const onCollabActiveRef = useRef(onCollabActive);
    // Saving is paused while a conflict waits for the user's choice…
    const pausedRef = useRef(false);
    // …and while the page joins a live session a save was refused for.
    const awaitingSessionRef = useRef(false);
    // The save in flight, with any newer text it sends after it.
    const inFlightRef = useRef<Promise<void> | null>(null);
    const skipRef = useRef(bound || readOnly);
    /** No save may go out now. */
    const held = useCallback(() => skipRef.current || pausedRef.current || awaitingSessionRef.current, []);
    // True from the first keystroke until a save completes. Distinct from
    // `saveState`, which only knows about saves that have already started.
    const dirtyRef = useRef(false);
    const [dirty, setDirty] = useState(false);
    /** Call from the editor's onChange so the unload guard sees debounced edits. */
    const markDirty = useCallback(() => {
        if (skipRef.current) return;
        dirtyRef.current = true;
        setDirty(true);
    }, []);

    useEffect(() => { onConflictRef.current = onConflict; }, [onConflict]);
    useEffect(() => { onCollabActiveRef.current = onCollabActive; }, [onCollabActive]);
    // A layout effect, so saving stops in the same commit the session takes
    // over, before any passive effect (the page's join watch) resumes it.
    useLayoutEffect(() => {
        skipRef.current = bound || readOnly;
        if (skipRef.current) {
            // Nothing of ours is pending once the live session (or read-only
            // mode) took over: the session saves, a viewer saves nothing. Text
            // typed while the page waited to join is not in the session: it is
            // kept as a version before the session's document replaces it.
            const unsent = bound && awaitingSessionRef.current && entityId ? pendingContentRef.current : null;
            if (unsent && entityId) {
                keepUnsavedCopy(entityId, unsent).catch((err) => console.error('[Notebooks] could not keep the unsaved text:', err));
            }
            pendingContentRef.current = null;
            dirtyRef.current = false;
            setDirty(false);
            if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
            setSaveState('idle');
        }
    }, [bound, readOnly, entityId]);

    // Track the latest initialVersion and seed the counter when it is still
    // unknown (the page usually learns the version from an async fetch, well
    // after this hook mounted). Never clobber a version adopted from a save.
    useEffect(() => {
        initialVersionRef.current = initialVersion ?? null;
        if (versionRef.current == null && initialVersion != null) versionRef.current = initialVersion;
    }, [initialVersion]);

    /** Resync the CAS counter from an out-of-band source (AI edit, restore, refetch). */
    const setKnownVersion = useCallback((v: number | null | undefined) => { versionRef.current = v ?? null; }, []);

    const saveRef = useRef<(html: string, opts?: { isRetry?: boolean }) => Promise<void>>(async () => {});

    const onSaved = useCallback((html: string, res: { version?: number } | null) => {
        if (res?.version != null) versionRef.current = res.version;
        if (pendingContentRef.current === html) pendingContentRef.current = null;
        dirtyRef.current = pendingContentRef.current != null;
        setDirty(dirtyRef.current);
        setSaveState('idle');
        setLastSavedAt(Date.now());
    }, []);

    /**
     * Somebody opened a live session meanwhile: this text was kept as a
     * version. The page joins and saving waits for it — unless the page
     * cannot join (onCollabActive answered false): then nothing would ever
     * resume the wait and later typing would never be saved, so saving goes on.
     */
    const awaitSession = useCallback((html: string, keptVersionId: string | null) => {
        // Waiting before the page is told, so a resume it calls at once is not lost.
        awaitingSessionRef.current = true;
        if (pendingContentRef.current === html) pendingContentRef.current = null;
        dirtyRef.current = pendingContentRef.current != null;
        setDirty(dirtyRef.current);
        setSaveState('idle');
        const tell = onCollabActiveRef.current;
        if (!tell || tell(keptVersionId) === false) awaitingSessionRef.current = false;
    }, []);

    /** A refused save. True when the server kept the text and saving goes on, so newer text may follow. */
    const onRefused = useCallback((e: SaveError, html: string, savingForId: string, isRetry: boolean): boolean => {
        const kind = refusalOf(e);
        const details: RefusalDetails = e.body?.details || {};
        if (kind === 'collab') { awaitSession(html, details.conflictVersionId ?? null); return !awaitingSessionRef.current; }
        if (kind === 'conflict') {
            pausedRef.current = true;
            setSaveState('conflict');
            onConflictRef.current?.({
                notebookId: savingForId,
                localHtml: html,
                conflictVersionId: details.conflictVersionId ?? null,
                currentVersion: details.currentVersion ?? null,
            });
            return false;
        }
        console.error('[Notebooks] Doc save failed:', e);
        setSaveState('error');
        // A permission error (401/403) can never succeed on retry — skip the
        // automatic 5s retry, but keep pendingContentRef so the header's
        // manual "Save failed — retry" affordance still works.
        if (isRetry || kind === 'permission') return false;
        retryTimerRef.current = setTimeout(() => {
            if (pendingContentRef.current !== null) void saveRef.current(pendingContentRef.current, { isRetry: true });
        }, 5000);
        return false;
    }, [awaitSession]);

    /** One PUT; true when it saved, or the server kept it and saving goes on (newer text may follow). */
    const sendOnce = useCallback(async (savingForId: string, html: string, isRetry: boolean): Promise<boolean> => {
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        setDocSaving(true);
        setSaveState('saving');
        try {
            const res = await putDocument(savingForId, html, versionRef.current);
            if (entityIdRef.current !== savingForId) return false; // switched entities mid-flight
            onSaved(html, res);
            return true;
        } catch (err) {
            return entityIdRef.current === savingForId && onRefused(err as SaveError, html, savingForId, isRetry);
        } finally {
            setDocSaving(false);
        }
    }, [onSaved, onRefused]);

    const handleDocSave = useCallback(async (html: string, { isRetry = false }: { isRetry?: boolean } = {}) => {
        if (!entityId || skipRef.current) return;
        pendingContentRef.current = html;
        // A conflict is waiting for the user, or a live session for the page:
        // keep the newest text pending, send nothing until then.
        if (held()) return;
        // One save at a time; the one in flight sends this text when it lands.
        if (inFlightRef.current) { await inFlightRef.current; return; }
        const run = (async () => {
            let text: string | null = html;
            let retry = isRetry;
            while (text != null) {
                const ok = await sendOnce(entityId, text, retry);
                const next: string | null = pendingContentRef.current;
                text = ok && next != null && next !== text && !held() ? next : null;
                retry = false;
            }
        })();
        inFlightRef.current = run;
        try { await run; } finally { if (inFlightRef.current === run) inFlightRef.current = null; }
    }, [entityId, held, sendOnce]);
    useEffect(() => { saveRef.current = handleDocSave; }, [handleDocSave]);

    /**
     * The user chose after a conflict. `keepServer`: the server copy (already
     * loaded into the editor by the page) stays; their text lives on as the
     * conflict version. Otherwise their text is saved over the version they
     * just compared against.
     */
    const resolveConflict = useCallback(async ({ keepServer, version, html }: { keepServer: boolean; version: number | null; html?: string }) => {
        pausedRef.current = false;
        versionRef.current = version;
        if (keepServer) {
            pendingContentRef.current = null;
            dirtyRef.current = false;
            setDirty(false);
            setSaveState('idle');
            return;
        }
        const text = html ?? pendingContentRef.current ?? '';
        await handleDocSave(text);
    }, [handleDocSave]);

    /**
     * The live session a save was refused for was joined, or the notebook is
     * not co-edited after all: saving resumes (with anything typed meanwhile,
     * unless the session now owns the document).
     */
    const resumeSaving = useCallback(() => {
        if (!awaitingSessionRef.current) return;
        awaitingSessionRef.current = false;
        if (pendingContentRef.current != null) void handleDocSave(pendingContentRef.current);
    }, [handleDocSave]);

    // On entity switch: cancel any pending retry + reset the indicator so a save
    // queued for the previous notebook can't clobber the new one. The cleanup
    // (which runs with the PREVIOUS entityId captured, on switch AND on
    // unmount) FLUSHES any unsaved content for the notebook being left, still
    // as a compare-and-set write: if somebody saved in between, the server
    // keeps this copy as a conflict version instead of overwriting them.
    //
    // A LAYOUT effect: on unmount (Back, another notebook, Reopen) its cleanup
    // runs before the editor child's imperative handle is detached. A passive
    // cleanup found editorRef already null, never flushed, and the editor's
    // own unmount then dropped its debounced save: the last seconds of typing
    // were lost without a word.
    useLayoutEffect(() => {
        entityIdRef.current = entityId;
        versionRef.current = initialVersionRef.current;
        pausedRef.current = false;
        awaitingSessionRef.current = false;
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        setSaveState('idle');
        setDocSaving(false);
        return () => {
            const leavingId = entityId;
            if (skipRef.current) { pendingContentRef.current = null; return; }
            // Ask the editor to give up any debounced edit FIRST: flush() saves
            // through the editor's own onSave (handleDocSave) and returns the HTML.
            let flushed: string | null = null;
            try {
                flushed = editorRef.current?.flush?.() ?? null;
            } catch (e) { console.error('[Notebooks] editor flush failed:', e); }
            if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
            // A save in flight sends the newest text itself when it lands; a
            // flushed save that was not held back is on its way already.
            if (inFlightRef.current) return;
            if (flushed != null && !pausedRef.current && !awaitingSessionRef.current) { pendingContentRef.current = null; return; }
            const pending = pendingContentRef.current;
            pendingContentRef.current = null;
            if (!leavingId || pending == null) return;
            // Held back by a conflict or a session to join: the server keeps
            // this copy as a version (a 409 here is not a loss).
            putDocument(leavingId, pending, versionRef.current).catch((err) => {
                if ((err as SaveError)?.status !== 409) console.error('[Notebooks] flush-on-switch save failed:', err);
            });
        };
    }, [entityId]);

    // Warn before closing the tab while anything is unsaved, and take one last
    // shot at persisting it (compare-and-set like every other save).
    useEffect(() => {
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (skipRef.current) return;
            const unsaved = (saveState !== 'idle' && saveState !== 'conflict') || dirtyRef.current;
            if (!unsaved) return;
            try { editorRef.current?.flush?.(); } catch { /* unload path */ }
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [saveState]);

    // Cmd/Ctrl+S bypasses the editor's debounce and saves immediately. While
    // co-editing it is swallowed (the session saves continuously).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const metaS = (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S');
            if (!metaS || !entityId) return;
            e.preventDefault();
            // A held key repeats: one save is enough.
            if (skipRef.current || e.repeat) return;
            const editor = editorRef.current?.getEditor?.();
            const html = editor?.getHTML?.() ?? documentContent;
            void handleDocSave(html);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [entityId, documentContent, handleDocSave]);

    /** Typed text that is not saved yet (read at call time, for event handlers). */
    const hasUnsaved = useCallback(() => !skipRef.current && (dirtyRef.current || pendingContentRef.current != null), []);
    /** The version the next save will be compared against. */
    const getKnownVersion = useCallback(() => versionRef.current, []);

    const retrySave = useCallback(() => {
        if (pendingContentRef.current !== null) void handleDocSave(pendingContentRef.current);
    }, [handleDocSave]);

    return {
        documentContent, setDocumentContent,
        docSaving, saveState, lastSavedAt, dirty,
        handleDocSave, retrySave, markDirty, setKnownVersion, resolveConflict, resumeSaving, hasUnsaved, getKnownVersion,
        editorRef, pendingContentRef,
    };
}
