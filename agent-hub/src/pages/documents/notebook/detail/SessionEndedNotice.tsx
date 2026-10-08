/**
 * SessionEndedNotice — the live session of this notebook ended after it had
 * started (the notebook moved or was deleted, co-editing was switched off,
 * access went, a change too large to share).
 *
 * When it ended before the server confirmed what was typed here (typing
 * while it was folded back, a backlog from offline, the paste that was too
 * large), those edits are only in this editor. They are kept as a version
 * (the 'conflict' copy a refused save gets) BEFORE the page offers to reopen,
 * which replaces the editor with the saved notebook. Until then there is no
 * way out that loses them; when they cannot be kept, the page says so and
 * leaves them on screen.
 */
import React, { useEffect, useRef, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { keepUnsavedCopy } from '../hooks/useDocumentAutosave';
import NotebookNotice, { type NoticeWithAction } from './NotebookNotice';
import { editorHtml, type NotebookEditorHandle } from './editorHandle';
import type { NotebookCollabState } from './useNotebookCollab';

type KeepState = 'keeping' | 'kept' | 'failed' | null;

interface Props {
    notebookId: string;
    collab: NotebookCollabState;
    editorRef: React.MutableRefObject<NotebookEditorHandle | null>;
    onReload: () => void;
}

/** Keep what the ended session never confirmed; once per session. */
function useKeepUnsent({ notebookId, collab, editorRef }: Omit<Props, 'onReload'>): KeepState {
    const [state, setState] = useState<KeepState>(null);
    const doneFor = useRef<unknown>(null);
    const { handle, ended } = collab;
    const unsent = ended && !!handle?.unsent;
    useEffect(() => {
        if (!unsent || !handle || doneFor.current === handle.ydoc) return;
        doneFor.current = handle.ydoc;
        const html = editorHtml(editorRef.current);
        if (html == null || !html.trim()) return;
        setState('keeping');
        keepUnsavedCopy(notebookId, html).then(() => setState('kept'), () => setState('failed'));
    }, [unsent, handle, notebookId, editorRef]);
    return unsent ? state : null;
}

export default function SessionEndedNotice({ notebookId, collab, editorRef, onReload }: Props) {
    const { t } = useTranslation();
    const keep = useKeepUnsent({ notebookId, collab, editorRef });
    const [hidden, setHidden] = useState(false);
    if (!collab.ended || hidden) return null;
    const reopen = { label: t('notebooks.reopen', 'Reopen'), onClick: onReload };
    let notice: NoticeWithAction;
    let dismiss = onReload;
    if (keep === 'keeping') {
        notice = { kind: 'info', message: t('notebooks.collab_ended_keeping', 'The live session ended before your last changes reached the others. They are being kept in the version history…'), action: null };
        dismiss = () => undefined;
    } else if (keep === 'kept') {
        notice = { kind: 'info', message: t('notebooks.collab_ended_kept', 'The live session ended before your last changes reached the others. They are kept in the version history. Reopen the notebook to continue.'), action: reopen };
    } else if (keep === 'failed') {
        notice = { kind: 'error', message: t('notebooks.collab_ended_unkept', 'The live session ended before your last changes were saved, and they could not be kept. Copy them from the page before you reopen the notebook.'), action: reopen };
        // Closing the notice must not reopen: the text is only on this page.
        dismiss = () => setHidden(true);
    } else {
        notice = { kind: 'error', message: t('notebooks.collab_ended', 'The live session ended. Reopen the notebook to continue.'), action: reopen };
    }
    return <NotebookNotice notice={notice} onDismiss={dismiss} />;
}
