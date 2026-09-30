// What a page keeps when a save cannot store its text, and how it offers it
// back (usePageDocument.ts wires it to the page's autosave):
//
//   - a DRAFT (useDocumentAutosave's sessionStorage copy): a tab closed before
//     its save, or a save refused once the page went live when the server
//     could not keep the text. Offered while the page is saved by revision;
//     putting it back saves it as a late save (merged, or kept again);
//   - KEPT LIVE: somebody opened the page live while a save was out. The
//     server keeps the refused text as a 'conflict' version and names it; the
//     page joins the live session (the editor then follows it) and points at
//     the kept copy instead of asking for a reload that would lose the text;
//   - UNSENT: the live session ended before the server confirmed what was
//     typed here (typing while the page was folded back, a backlog from
//     offline, a paste too large to share). Those edits are only in the
//     editor: they go in as one save (merged when the page is no longer live,
//     kept as a version when it still is), never left to a reload.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollabHandle } from '../../../editor/collab/useCollab';
import useTranslation from '../../../hooks/useTranslation';
import { readDraft, type Draft } from '../useDocumentAutosave';

interface PageRecoveryOptions {
    documentId: string;
    collab: CollabHandle | null;
}

export default function usePageRecovery({ documentId, collab }: PageRecoveryOptions) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<Draft | null>(() => readDraft(documentId));
    const [keptLive, setKeptLive] = useState<string | null>(null);
    // Live, with no session to join (filed into a project since the page was
    // opened): only a reload joins, and nothing more is typed until then.
    const [noSession, setNoSession] = useState(false);

    /** useDocumentAutosave's `onLive`: true when the text is safe on the server. */
    const onLive = useCallback((e: { conflictVersionId?: string | null }) => {
        const kept = typeof e?.conflictVersionId === 'string' ? e.conflictVersionId : null;
        if (!kept) { setDraft(readDraft(documentId)); return false; }
        setKeptLive(kept);
        if (collab) collab.retry();
        else setNoSession(true);
        return true;
    }, [documentId, collab]);

    return {
        draft,
        keptLive,
        onLive,
        /** Why the page stopped taking edits, or null. */
        reloadError: noSession ? t('documents.page.live_reload', 'This page is now edited live. Reload it to join in; what you typed is kept in its version history.') : null,
        dismissKeptLive: () => setKeptLive(null),
        /** The draft, handed over once: the notice goes away while it is saved. */
        takeDraft: () => { const d = draft; setDraft(null); return d; },
        forgetDraft: () => setDraft(null),
    };
}

/**
 * A live session that ended with edits the server never confirmed: the
 * editor's text goes in as one save, once per session (usePageRecovery.ts).
 */
export function useSaveUnsent(
    collab: CollabHandle | null,
    autosave: { markDirty: (html: string) => void; flush: () => Promise<void> },
    editorHtml: () => string | null,
) {
    const doneFor = useRef<unknown>(null);
    const unsent = !!collab?.unsent && (collab.status === 'error' || collab.status === 'disabled');
    useEffect(() => {
        if (!unsent || !collab || doneFor.current === collab.ydoc) return;
        doneFor.current = collab.ydoc;
        const html = editorHtml();
        if (html == null || !html.trim()) return;
        autosave.markDirty(html);
        autosave.flush().catch(() => undefined);
    }, [unsent, collab, autosave, editorHtml]);
}
