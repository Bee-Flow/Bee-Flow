// The state of an open designed document (a letter, a report, a deck): the
// document as the server holds it, saving (useDocumentAutosave), changes by
// others put into the frame, the assistant's edits, settings saves, rename,
// downloads and print. DesignedEditor.tsx is the screen around it.

import { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { projectErrorText } from '../../../components/projects/workspace/projectErrorText';
import type { CanvasHandle } from '../DocumentCanvas';
import { extractSections } from '../canvasBridge';
import { downloadPdf, downloadPptx, fetchPreviewHtml, fetchRendered, getDocument, updateDocument } from '../documentsApi';
import type { StudioDocument } from '../documentQueries';
import useDocumentAutosave, { readDraft, type Draft } from '../useDocumentAutosave';

export interface WorkspaceHandle { flush?: () => Promise<void> }

export interface DesignedDocumentOptions {
    initial: StudioDocument;
    canvasRef: React.RefObject<CanvasHandle | null>;
    workspaceRef: React.RefObject<WorkspaceHandle | null>;
    onRenamed?: (doc: StudioDocument) => void;
}

const PRINT_URL_TTL_MS = 60_000;

/** An error as a sentence in the reader's language. */
function useErrorText() {
    const { t } = useTranslation();
    return useCallback((e: unknown): string => {
        if (!e) return '';
        if (typeof e === 'string') return e;
        return projectErrorText(t, e as Error) || (e as Error).message || t('documents.save_failed', 'Could not save your changes.');
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
    const failed = (e: unknown, format: 'pdf' | 'pptx') => setError(errorText(e) || (format === 'pptx' ? t('documents.pptx_failed', 'Could not build the presentation.') : t('documents.pdf_failed', 'Could not render the PDF.')));
    const download = async (format: 'pdf' | 'pptx') => {
        setDownloading(true); setError(null); setNotice(null);
        try {
            // Persist first: a PDF without the sentence just typed is the bug
            // people never report and always notice.
            await before();
            const run = format === 'pptx' ? downloadPptx : downloadPdf;
            const { degraded } = await run(id, docRef.current?.name, docRef.current?.versionId);
            if (degraded) setNotice(t('documents.pdf_degraded', 'The PDF was made without the rendering container, so its layout is plainer than the screen.'));
        } catch (e) { failed(e, format); } finally { setDownloading(false); }
    };
    /** Print: the rendered PDF, with its page breaks, in a tab of its own. */
    const print = async () => {
        setDownloading(true); setError(null);
        try {
            await before();
            const { blob } = await fetchRendered(id, docRef.current?.versionId, 'pdf');
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), PRINT_URL_TTL_MS);
        } catch (e) { failed(e, 'pdf'); } finally { setDownloading(false); }
    };
    return { download, print, downloading };
}

/**
 * The chat can rewrite this document while it is open: save what was typed
 * (merged with the assistant's edit), then show the result.
 */
function useChatUpdates(id: string, reload: () => Promise<void>, onError: (e: unknown) => void) {
    useEffect(() => {
        const onUpdate = (e: Event) => {
            if ((e as CustomEvent).detail?.documentId !== id) return;
            reload().catch(onError);
        };
        window.addEventListener('beeflow:document-updated', onUpdate);
        return () => window.removeEventListener('beeflow:document-updated', onUpdate);
    }, [id, reload, onError]);
}

export default function useDesignedDocument({ initial, canvasRef, workspaceRef, onRenamed }: DesignedDocumentOptions) {
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
            } catch { /* shown on the next reload */ }
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

    /** Show the server's newest state in the frame, after saving what was typed. */
    const reload = useCallback(async () => {
        await workspaceRef.current?.flush?.();
        await flushEditor();
        const latest = await getDocument(initial.id) as StudioDocument;
        apply({ ...docRef.current, ...latest });
        autosave.syncedTo(latest);
        setMergedUnseen(false);
        setReloadKey((k) => k + 1);
        setPanelEpoch((k) => k + 1);
    }, [workspaceRef, flushEditor, initial.id, apply, autosave]);

    /** A settings / name / reviewed-proposal save, one after the pending body. */
    const savePatch = useCallback(async (patch: Partial<StudioDocument>) => {
        await flushEditor().catch(() => undefined);
        try {
            const saved = await autosave.enqueue(() => updateDocument(initial.id, { ...patch, expectedVersionId: docRef.current?.versionId }) as Promise<StudioDocument>);
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
            }
            throw e;
        }
    }, [flushEditor, autosave, initial.id, apply, canvasRef]);

    const rename = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed === docRef.current?.name) return;
        try { onRenamed?.(await savePatch({ name: trimmed })); }
        catch (e) { setError(errorText(e)); }
    }, [savePatch, onRenamed, errorText]);

    const toggleHouseStyle = useCallback(async () => {
        const settings = docRef.current?.settings || {};
        try {
            await workspaceRef.current?.flush?.();
            // Merge, never replace: settings is a wholesale column.
            await savePatch({ settings: { ...settings, houseStyle: settings.houseStyle === false } });
            setPanelEpoch((k) => k + 1);
        } catch (e) { setError(errorText(e)); }
    }, [workspaceRef, savePatch, errorText]);

    const output = useDocumentOutput({ id: initial.id, docRef, before: async () => { await workspaceRef.current?.flush?.(); await flushEditor(); }, setError, setNotice, errorText });

    const onChatError = useCallback((err: unknown) => { if ((err as { status?: number })?.status !== 409) setError(errorText(err)); }, [errorText]);
    useChatUpdates(initial.id, reload, onChatError);

    const autosaveError = autosave.error ? errorText(autosave.error) : null;
    return {
        doc, docRef, apply, isDeck, readOnly, reloadKey, panelEpoch, setPanelEpoch, setReloadKey,
        autosave, flushEditor, reload, savePatch, rename, toggleHouseStyle, download: output.download, print: output.print, downloading: output.downloading,
        error: error || autosaveError, notice,
        clearError: () => { setError(null); setNotice(null); autosave.clearError(); },
        setError: (e: unknown) => setError(errorText(e)),
        mergedUnseen, dismissMerged: () => setMergedUnseen(false),
        draft,
        /** The kept draft back into this document (merged like a late save), then shown. */
        restoreDraft: async () => {
            const d = draft;
            setDraft(null);
            if (!d) return;
            try {
                await autosave.restoreDraft(d);
                await reload();
            } catch { /* a conflict opens "compare and choose"; any other failure is on the save chip */ }
        },
        discardDraft: () => { autosave.dropDraft(); setDraft(null); },
    };
}

export type DesignedDocumentState = ReturnType<typeof useDesignedDocument>;
