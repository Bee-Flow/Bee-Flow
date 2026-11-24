// The state of an open designed document (a letter, a report, a deck): the
// document as the server holds it, saving (useDocumentAutosave), changes by
// others put into the frame, the assistant's edits, settings saves, rename,
// downloads and print. DesignedEditor.tsx is the screen around it.

import { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { projectErrorText } from '@/components/projects/workspace/projectErrorText';
import type { CanvasHandle } from '../DocumentCanvas';
import { extractSections } from '../canvasBridge';
import { downloadPdf, downloadPptx, fetchPreviewHtml, fetchRendered, getDocument, updateDocument } from '../documentsApi';
import type { StudioDocument } from '../documentQueries';
import useDocumentAutosave, { readDraft, type Draft } from '../useDocumentAutosave';
import { errorCode, messageOf, errorStatus } from '@/utils/caughtError';
import { logger } from '@/utils/logger';
import { closePrintTab, openPrintTab, showInPrintTab } from './printTab';

export interface WorkspaceHandle { flush?: () => Promise<void> }

export interface DesignedDocumentOptions {
    initial: StudioDocument;
    canvasRef: React.RefObject<CanvasHandle | null>;
    workspaceRef: React.RefObject<WorkspaceHandle | null>;
    onRenamed?: (doc: StudioDocument) => void;
}


/** An error as a sentence in the reader's language. */
function useErrorText() {
    const { t } = useTranslation();
    return useCallback((e: unknown): string => {
        if (!e) return '';
        if (typeof e === 'string') return e;
        return projectErrorText(t, e) || messageOf(e, t('documents.save_failed', 'Could not save your changes.'));
    }, [t]);
}

/** Put the sections others changed into the frame; true when it now shows the server's state. */
async function showOthersChanges(canvas: CanvasHandle | null, saved: StudioDocument): Promise<boolean> {
    const merge = saved.merge;
    if (!merge || (!merge.fromOthers.length && !merge.othersOutsideSections)) return true;
    if (!canvas || merge.othersOutsideSections || saved.docType === 'presentation') return false;
    const sections = extractSections(await fetchPreviewHtml(saved.id), merge.fromOthers);
    const result = await canvas.patchSections(sections);
    return result.missing.length === 0;
}

/** After others' sections went into the frame: its body as it is now (answered through onDirty). */
async function rereadFrame(canvas: CanvasHandle | null): Promise<void> {
    if (!canvas) throw new Error('no frame');
    await canvas.flush();
}

/** Download (PDF, .pptx) and print, each after saving what was typed. */
function useDocumentOutput({ id, docRef, before, setError, setNotice, errorText }: {
    id: string; docRef: React.MutableRefObject<StudioDocument | null>; before: () => Promise<void>;
    setError: (e: string | null) => void; setNotice: (n: string | null) => void; errorText: (e: unknown) => string;
}) {
    const { t } = useTranslation();
    const [downloading, setDownloading] = useState(false);
    // Values the final file needs are not filled in yet: what is missing, said where they are filled in.
    const [inputNeeded, setInputNeeded] = useState<string | null>(null);
    const failed = (e: unknown, format: 'pdf' | 'pptx') => {
        if (errorCode(e) === 'document_validation_failed') { setInputNeeded(messageOf(e, '')); return; }
        setError(errorText(e) || (format === 'pptx' ? t('documents.pptx_failed', 'Could not build the presentation.') : t('documents.pdf_failed', 'Could not render the PDF.')));
    };
    const download = async (format: 'pdf' | 'pptx') => {
        setDownloading(true); setError(null); setNotice(null); setInputNeeded(null);
        try {
            // Persist first: a PDF without the sentence just typed is the bug
            // people never report and always notice.
            await before();
            const run = format === 'pptx' ? downloadPptx : downloadPdf;
            const { degraded } = await run(id, docRef.current?.name, docRef.current?.versionId);
            if (degraded) setNotice(t('documents.pdf_degraded', 'The PDF was made without the rendering container, so its layout is plainer than the screen.'));
        } catch (e) { failed(e, format); } finally { setDownloading(false); }
    };
    /** Print: the rendered PDF, with its page breaks, in a tab of its own (opened in the click: see printTab.ts). */
    const print = async () => {
        const tab = openPrintTab();
        setDownloading(true); setError(null); setInputNeeded(null);
        try {
            await before();
            // No tab (the browser blocked it): the PDF is downloaded instead, to print from there.
            if (!tab) { await downloadPdf(id, docRef.current?.name, docRef.current?.versionId); return; }
            const { blob } = await fetchRendered(id, docRef.current?.versionId, 'pdf');
            showInPrintTab(tab, blob);
        } catch (e) { closePrintTab(tab); failed(e, 'pdf'); } finally { setDownloading(false); }
    };
    return { download, print, downloading, inputNeeded, clearInputNeeded: () => setInputNeeded(null), saveAll: before };
}

/**
 * The chat can rewrite this document while it is open: save what was typed
 * (merged with the assistant's edit), then show the result.
 */
function useChatUpdates(id: string, reload: (opts?: { flush?: boolean }) => Promise<void>, onError: (e: unknown) => void) {
    useEffect(() => {
        const onUpdate = (e: Event) => {
            if ((e as CustomEvent).detail?.documentId !== id) return;
            reload().catch(onError);
        };
        window.addEventListener('beeflow:document-updated', onUpdate);
        return () => window.removeEventListener('beeflow:document-updated', onUpdate);
    }, [id, reload, onError]);
}

type Autosave = ReturnType<typeof useDocumentAutosave>;

/**
 * Rename: only the name, on the newest revision (the name is never merged, so
 * a stale base would only be refused). When it fails anyway, the name field
 * goes back to the saved name (`nameKey`) and the reason is said plainly.
 */
function useRename({ id, docRef, autosave, apply, onRenamed, setError, errorText }: {
    id: string; docRef: React.MutableRefObject<StudioDocument | null>; autosave: Autosave; apply: (d: StudioDocument) => void;
    onRenamed?: (doc: StudioDocument) => void; setError: (e: string | null) => void; errorText: (e: unknown) => string;
}) {
    const { t } = useTranslation();
    const [nameKey, setNameKey] = useState(0);
    const rename = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed === docRef.current?.name) { setNameKey((k) => k + 1); return; }
        try {
            // Read in the save queue: a body save still out would otherwise make "newest" stale at once.
            const { latest, saved } = await autosave.enqueue(async () => {
                const newest = await getDocument(id) as StudioDocument;
                return { latest: newest, saved: await updateDocument(id, { name: trimmed, expectedVersionId: newest.versionId }) as StudioDocument };
            });
            // Somebody else saved meanwhile: keep the revision this editor has
            // seen, so its next save is still merged with theirs, never over it.
            const behind = latest.versionId !== docRef.current?.versionId;
            apply({ ...docRef.current!, name: saved.name, ...(behind ? {} : { versionId: saved.versionId, updatedAt: saved.updatedAt }) });
            onRenamed?.(docRef.current!);
        } catch (e) {
            setNameKey((k) => k + 1);
            setError(errorStatus(e) === 409
                ? t('doc_editor.rename_conflict', 'Rename failed: the document changed meanwhile. Try again.')
                : t('doc_editor.rename_failed', 'Rename failed: {reason}', { reason: errorText(e) }));
        }
    }, [id, docRef, autosave, apply, onRenamed, setError, errorText, t]);
    return { rename, nameKey };
}

interface FillSyncOptions {
    id: string;
    docRef: React.RefObject<StudioDocument | null>;
    apply: (next: StudioDocument) => void;
    syncedTo: (doc: StudioDocument) => void;
}

/** How long after the form's last save the editor catches up: once per pause in typing, not per keystroke. */
const FILL_SYNC_MS = 400;

/**
 * The fill-in form (the "Fill in & preview" tab) saves the values through its
 * own route, and in a project colleagues save theirs too. Each answer of that
 * route names the document's revision: when it is another one than the editor
 * holds, the editor takes the document as it is now, so its next save (of the
 * settings, or of the sheet) is made on that revision and with those values.
 *
 * Only when the SHEET did not change with it: the form's routes never touch
 * the body, so then the frame still shows that revision and nothing has to be
 * redrawn (a redraw would throw the cursor out of the sheet). When somebody
 * else changed the sheet as well, nothing is taken over here: the next save
 * finds the newer revision and merges, as it always did.
 */
function useFillSync({ id, docRef, apply, syncedTo }: FillSyncOptions) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    return useCallback((out: { versionId?: string | null }) => {
        if (!out.versionId || out.versionId === docRef.current?.versionId) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
            const held = docRef.current;
            try {
                const latest = await getDocument(id) as StudioDocument;
                // Saved here meanwhile (the editor's own autosave): that state is newer than what was just read.
                if (!held || docRef.current !== held) return;
                if (latest.bodyHtml !== held.bodyHtml || latest.css !== held.css) return;
                apply({ ...held, ...latest });
                syncedTo(latest);
            } catch (err) {
                // The form's own save succeeded; the editor catches up on its next save or reload.
                logger.debug('the editor did not take over what the form saved', err);
            }
        }, FILL_SYNC_MS);
    }, [id, docRef, apply, syncedTo]);
}

export default function useDesignedDocument({ initial, canvasRef, workspaceRef, onRenamed }: DesignedDocumentOptions) {
    const { t } = useTranslation();
    const errorText = useErrorText();
    const docRef = useRef<StudioDocument | null>(initial);
    const [doc, setDocState] = useState<StudioDocument>(initial);
    const [reloadKey, setReloadKey] = useState(0);
    const [panelEpoch, setPanelEpoch] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [mergedUnseen, setMergedUnseen] = useState(false);
    const [readOnly, setReadOnly] = useState(initial.editable === false);
    const [draft, setDraft] = useState<Draft | null>(() => {
        const kept = readDraft(initial.id);
        return kept && kept.html !== initial.bodyHtml ? kept : null;
    });
    const isDeck = doc.docType === 'presentation';

    const apply = useCallback((next: StudioDocument) => { docRef.current = next; setDocState(next); }, []);

    const autosave = useDocumentAutosave({
        documentId: initial.id,
        docRef,
        onSaved: apply,
        onMerged: async (saved) => {
            try {
                if (await showOthersChanges(canvasRef.current, saved)) return true;
            } catch (err) { logger.debug('shown on the next reload', err); }
            setMergedUnseen(true);
            return false;
        },
        onReadOnly: () => { setReadOnly(true); apply({ ...docRef.current!, editable: false }); },
        reread: () => rereadFrame(canvasRef.current),
    });

    /** Everything typed, saved. For a deck the outline is saved by the autosave alone. */
    const flushEditor = useCallback(async () => {
        if (docRef.current?.docType !== 'presentation') await canvasRef.current?.flush();
        await autosave.flush();
    }, [canvasRef, autosave]);

    /**
     * Show the server's newest state in the frame, after saving what was typed. `flush: false` when the
     * server already holds what should be shown (a restored draft): the frame still has the old body, and
     * flushing it would save that over the draft.
     */
    const reload = useCallback(async ({ flush = true }: { flush?: boolean } = {}) => {
        if (flush) {
            await workspaceRef.current?.flush?.();
            await flushEditor();
        }
        const latest = await getDocument(initial.id) as StudioDocument;
        apply({ ...docRef.current, ...latest });
        autosave.syncedTo(latest);
        setMergedUnseen(false);
        setReloadKey((k) => k + 1);
        setPanelEpoch((k) => k + 1);
    }, [workspaceRef, flushEditor, initial.id, apply, autosave]);

    /**
     * A settings / reviewed-proposal save, one after the pending body. A
     * caller that passes `expectedVersionId` (a proposal, recovered settings)
     * is saved on THAT revision: when the document moved on since, the server
     * refuses it instead of the proposal silently replacing newer work.
     */
    const savePatch = useCallback(async (patch: Partial<StudioDocument> & { expectedVersionId?: string }) => {
        const { expectedVersionId: pinned, ...changes } = patch;
        await flushEditor().catch(() => undefined);
        try {
            const saved = await autosave.enqueue(() => updateDocument(initial.id, { ...changes, expectedVersionId: pinned || docRef.current?.versionId }) as Promise<StudioDocument>);
            apply({ ...docRef.current, ...saved });
            if (['bodyHtml', 'css', 'settings'].some((k) => Object.hasOwn(patch, k))) {
                canvasRef.current?.invalidate();
                autosave.syncedTo(saved);
                setReloadKey((k) => k + 1);
            }
            return docRef.current!;
        } catch (e: any) {
            // Somebody else saved first: take their state, so the next try is
            // made on it, and say so (settings are never merged).
            if (e?.status === 409) {
                const latest = await getDocument(initial.id).catch(() => null) as StudioDocument | null;
                if (latest) { apply({ ...docRef.current, ...latest }); setPanelEpoch((k) => k + 1); }
                // The panel that asked starts again on the newest state, so the reason is said here.
                if (pinned) setError(t('doc_editor.stale_not_applied', 'Nothing was applied: the document changed after these changes were prepared, and your newer work is kept. Look at the current version and try again.'));
            }
            throw e;
        }
    }, [flushEditor, autosave, initial.id, apply, canvasRef, t]);

    const fillSynced = useFillSync({ id: initial.id, docRef, apply, syncedTo: autosave.syncedTo });

    const { rename, nameKey } = useRename({ id: initial.id, docRef, autosave, apply, onRenamed, setError, errorText });

    const toggleHouseStyle = useCallback(async () => {
        const settings = docRef.current?.settings || {};
        try {
            await workspaceRef.current?.flush?.();
            // Merge, never replace: settings is a wholesale column.
            await savePatch({ settings: { ...settings, houseStyle: settings.houseStyle === false } });
            setPanelEpoch((k) => k + 1);
        } catch (e) { setError(errorText(e)); }
    }, [workspaceRef, savePatch, errorText]);

    // The panel's settings and the typed text, both saved: before anything leaves as a file.
    const output = useDocumentOutput({ id: initial.id, docRef, before: async () => { await workspaceRef.current?.flush?.(); await flushEditor(); }, setError, setNotice, errorText });

    const onChatError = useCallback((err: unknown) => { if (errorStatus(err) !== 409) setError(errorText(err)); }, [errorText]);
    useChatUpdates(initial.id, reload, onChatError);

    const autosaveError = autosave.error ? errorText(autosave.error) : null;
    return {
        doc, docRef, apply, isDeck, readOnly, reloadKey, panelEpoch, setPanelEpoch, setReloadKey,
        autosave, flushEditor, saveAll: output.saveAll, reload, savePatch, fillSynced, rename, nameKey, toggleHouseStyle, download: output.download, print: output.print, downloading: output.downloading,
        inputNeeded: output.inputNeeded, clearInputNeeded: output.clearInputNeeded,
        error: error || autosaveError, notice,
        clearError: () => { setError(null); setNotice(null); autosave.clearError(); },
        setError: (e: unknown) => setError(errorText(e)),
        describeError: errorText,
        mergedUnseen, dismissMerged: () => setMergedUnseen(false),
        draft,
        /** The kept draft back into this document (merged like a late save), then shown. */
        restoreDraft: async () => {
            const d = draft;
            setDraft(null);
            if (!d) return;
            try {
                await autosave.restoreDraft(d);
                await reload({ flush: false });
            } catch (err) { logger.debug('a conflict opens "compare and choose"; any other failure is on the save chip', err); }
        },
        discardDraft: () => { autosave.dropDraft(); setDraft(null); },
    };
}

type DesignedDocumentState = ReturnType<typeof useDesignedDocument>;
