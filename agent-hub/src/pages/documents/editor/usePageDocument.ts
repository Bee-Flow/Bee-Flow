// The state of an open page: live together (useCollab, when the page is filed
// in a project and live editing is on) or saved by revision (a page of one's
// own, or live editing switched off), plus rename, print, download and the
// assistant's edits. PageEditor.tsx is the screen around it.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollabHandle } from '../../../editor/collab/useCollab';
import useCollab from '../../../editor/collab/useCollab';
import useTranslation from '../../../hooks/useTranslation';
import { projectErrorText } from '../../../components/projects/workspace/projectErrorText';
import { downloadPdf, fetchRendered, getDocument, updateDocument } from '../documentsApi';
import type { StudioDocument } from '../documentQueries';
import useDocumentAutosave from '../useDocumentAutosave';
import usePageRecovery from './usePageRecovery';

// A page embeds its pictures (the PDF renderer fetches nothing), so each is
// kept small; the whole page has the store's 512 KB cap. The same cap holds
// live together: there a picture reaches the server inside ONE co-editing
// update as base64 (300 KB is about 410 KB), and the server takes a single
// update of up to 576 KB (core/collab/limits maxUpdateBytes), sized for it.
const MAX_IMAGE_BYTES = 300 * 1024;
const PRINT_URL_TTL_MS = 60_000;

export interface PageEditorHandle {
    setContent?: (html: string) => void;
    /** New content as ONE undoable step, keeping caret and scroll (an assistant edit, a restore). */
    replaceDocument?: (html: string) => void;
}

/** Show stored content without losing the way back: Ctrl+Z undoes an assistant edit or a restore. */
function showInEditor(handle: PageEditorHandle | null | undefined, html: string) {
    if (handle?.replaceDocument) handle.replaceDocument(html);
    else handle?.setContent?.(html);
}

export interface PageDocumentOptions {
    initial: StudioDocument;
    currentUser: { id: string; name?: string } | null;
    editorRef: React.RefObject<PageEditorHandle | null>;
    onRenamed?: (doc: StudioDocument) => void;
}

/** Live when a session exists and has not said this page is not co-edited. */
export function isLive(handle: CollabHandle | null): handle is CollabHandle {
    return !!handle && handle.status !== 'disabled';
}

/** A picture as a data: URL the page can carry, or an error when it is too large. */
export function readImage(file: File, maxBytes = MAX_IMAGE_BYTES): Promise<{ src: string; alt: string }> {
    return new Promise((resolve, reject) => {
        if (file.size > maxBytes) { reject(new Error('image_too_large')); return; }
        const reader = new FileReader();
        reader.onload = () => resolve({ src: String(reader.result || ''), alt: file.name });
        reader.onerror = () => reject(new Error('image_unreadable'));
        reader.readAsDataURL(file);
    });
}

/** What the page offers back (usePageRecovery.ts); a draft only while it is saved by revision. */
function recoveryActions(recovery: ReturnType<typeof usePageRecovery>, live: boolean, autosave: ReturnType<typeof useDocumentAutosave>, showSaved: () => void) {
    return {
        keptLive: recovery.keptLive,
        dismissKeptLive: recovery.dismissKeptLive,
        draft: live ? null : recovery.draft,
        /** The kept draft back into the page, merged like a late save, then shown. */
        restoreDraft: async () => {
            const d = recovery.takeDraft();
            if (!d) return;
            // Not saved (a conflict to choose from, an error): the notice says so, the editor stays.
            try { await autosave.restoreDraft(d); } catch { return; }
            showSaved();
        },
        discardDraft: () => { autosave.dropDraft(); recovery.forgetDraft(); },
    };
}

/** A restore landed: a live page follows by itself; a stored one is replaced here. */
function restoredHandler(live: boolean, autosave: ReturnType<typeof useDocumentAutosave>, editorRef: React.RefObject<PageEditorHandle | null>) {
    return (current: unknown) => {
        if (live || !current || typeof current !== 'object') return;
        const next = current as StudioDocument;
        autosave.replaceWith(next);
        showInEditor(editorRef.current, next.bodyHtml);
    };
}

export default function usePageDocument({ initial, currentUser, editorRef, onRenamed }: PageDocumentOptions) {
    const { t } = useTranslation();
    const docRef = useRef<StudioDocument | null>(initial);
    const [doc, setDoc] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [mergedUnseen, setMergedUnseen] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [readOnly, setReadOnly] = useState(initial.editable === false);
    const apply = useCallback((next: StudioDocument) => { docRef.current = next; setDoc(next); }, []);
    const errorText = useCallback((e: unknown) => (typeof e === 'string' ? e : projectErrorText(t, e as Error) || (e as Error)?.message || ''), [t]);

    const collab = useCollab({
        projectId: initial.projectId || null, kind: 'document', resourceId: initial.id,
        enabled: !!initial.projectId && !!currentUser, user: currentUser,
    });
    const live = isLive(collab);
    const recovery = usePageRecovery({ documentId: initial.id, collab });

    const autosave = useDocumentAutosave({
        documentId: initial.id, docRef, onSaved: apply,
        // Never swapped under the caret: the next save merges again, and the
        // person can choose to see the combined text.
        onMerged: async () => { setMergedUnseen(true); return false; },
        onReadOnly: () => { setReadOnly(true); apply({ ...docRef.current!, editable: false }); },
        // Somebody opened the page live meanwhile (usePageRecovery.ts).
        onLive: recovery.onLive,
    });

    /** The editor's debounced save, in the revision mode. */
    const onSave = useCallback((html: string) => {
        if (live || readOnly) return;
        autosave.markDirty(html);
        autosave.flush().catch(() => undefined);
    }, [live, readOnly, autosave]);

    /** The newest stored state into the editor (revision mode only: live pages follow by themselves). */
    const showLatest = useCallback(async () => {
        await autosave.flush().catch(() => undefined);
        const latest = await getDocument(initial.id) as StudioDocument;
        autosave.replaceWith({ ...docRef.current, ...latest });
        showInEditor(editorRef.current, latest.bodyHtml);
        setMergedUnseen(false);
    }, [autosave, initial.id, editorRef]);

    const rename = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed === docRef.current?.name) return;
        try {
            // A live page moves its revision with every checkpoint: rename on the newest.
            const latest = await getDocument(initial.id) as StudioDocument;
            const saved = await autosave.enqueue(() => updateDocument(initial.id, { name: trimmed, expectedVersionId: latest.versionId }) as Promise<StudioDocument>);
            apply({ ...docRef.current, ...saved });
            onRenamed?.(saved);
        } catch (e) { setError(errorText(e)); }
    }, [initial.id, autosave, apply, onRenamed, errorText]);

    const render = useCallback(async (how: 'print' | 'download') => {
        setDownloading(true); setError(null);
        try {
            if (!live) await autosave.flush();
            if (how === 'download') { await downloadPdf(initial.id, docRef.current?.name, null); return; }
            const { blob } = await fetchRendered(initial.id, null, 'pdf');
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), PRINT_URL_TTL_MS);
        } catch (e) {
            setError(errorText(e) || t('documents.pdf_failed', 'Could not render the PDF.'));
        } finally { setDownloading(false); }
    }, [live, autosave, initial.id, errorText, t]);

    // The chat edited this page: a live page already shows it; otherwise
    // save what was typed (merged with the edit) and show the result.
    useEffect(() => {
        const onUpdate = (e: Event) => {
            if ((e as CustomEvent).detail?.documentId !== initial.id || live) return;
            showLatest().catch((err) => setError(errorText(err)));
        };
        window.addEventListener('beeflow:document-updated', onUpdate);
        return () => window.removeEventListener('beeflow:document-updated', onUpdate);
    }, [initial.id, live, showLatest, errorText]);

    const collabError = collab?.status === 'error';
    return {
        /** The page's image uploader: the picture is carried in the page, with one cap however it is saved. */
        uploadImage: (file: File) => readImage(file),
        doc, docRef, collab, live, readOnly: readOnly || collabError || collab?.status === 'readonly' || !!recovery.reloadError,
        autosave, onSave, rename, showLatest, downloading,
        print: () => render('print'), download: () => render('download'),
        error: error || recovery.reloadError || (autosave.error ? errorText(autosave.error) : null),
        clearError: () => { setError(null); autosave.clearError(); },
        mergedUnseen, dismissMerged: () => setMergedUnseen(false),
        ...recoveryActions(recovery, live, autosave, () => { if (docRef.current) showInEditor(editorRef.current, docRef.current.bodyHtml); }),
        onRestored: restoredHandler(live, autosave, editorRef),
    };
}
