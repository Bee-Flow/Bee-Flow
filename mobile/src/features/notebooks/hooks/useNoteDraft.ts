/**
 * The notes draft: what the Notes tab shows and edits, and its autosave —
 * the web's useDocumentAutosave (pages/notebooks/hooks) for a phone. The
 * bookkeeping is model/noteSaver.ts; this hook gives it the HTTP calls and
 * the caches, and hands the screen its state.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import { getNotebook, saveNotebookDocument } from '../api/endpoints';
import { notebookKeys } from '../api/keys';
import { EMPTY_NOTE, NoteSaver, type NoteSaverDeps, type NoteView } from '../model/noteSaver';
import { appendToNote, editableNote, storableMarkdown } from '../model/noteText';
import type { Notebook, NotebookDetailResponse } from '../model/types';

export { AUTOSAVE_MS, type NoteStatus } from '../model/noteSaver';

function useSaverDeps(notebookId: string): NoteSaverDeps {
    const t = useTranslation();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const writeCache = (patch: Partial<Notebook>) =>
        queryClient.setQueryData<NotebookDetailResponse | null>(notebookKeys.detail(notebookId), (old) =>
            old ? { ...old, notebook: { ...old.notebook, ...patch } } : old,
        );
    return {
        save: (text, expectedVersion) => saveNotebookDocument(notebookId, storableMarkdown(text), expectedVersion),
        onSaved: (text, version) => {
            const stored = storableMarkdown(text);
            // The saved body IS the Markdown mirror now (notebookStore._updateNotebook).
            writeCache({ documentContent: stored, documentMd: stored, documentFormat: 'markdown', ...(version !== null ? { version } : {}) });
            void queryClient.invalidateQueries({ queryKey: notebookKeys.all, refetchType: 'none' });
        },
        reload: async () => {
            const fresh = await getNotebook(notebookId);
            if (!fresh) return null;
            writeCache(fresh.notebook);
            toast(t('notebooks.doc_conflict', 'Document was updated elsewhere — reloaded'));
            return { text: editableNote(fresh.notebook).text, version: fresh.notebook.version };
        },
        describe: (err) => describeError(err).message,
        isConflict: (err) => err instanceof ApiError && err.status === 409,
    };
}

export function useNoteDraft(notebookId: string, notebook: Notebook | null) {
    const queryClient = useQueryClient();
    const deps = useSaverDeps(notebookId);
    const [view, setView] = useState<NoteView>(EMPTY_NOTE);
    const [saver] = useState(() => new NoteSaver(deps, setView));
    useEffect(() => saver.configure(deps));

    const note = useMemo(() => (notebook ? editableNote(notebook) : null), [notebook]);
    // A newer server copy (the AI rewrote the notes from the chat) is taken
    // only while nothing here is unsaved.
    useEffect(() => {
        if (notebook && note) saver.adopt(notebook.version, note.text);
    }, [saver, notebook, note]);

    useEffect(
        () => () => {
            void saver.leave()?.then(() => queryClient.invalidateQueries({ queryKey: notebookKeys.detail(notebookId) }));
        },
        [saver, queryClient, notebookId],
    );

    const editable = note?.editable ?? false;
    const edit = (text: string) => {
        if (editable) saver.edit(text);
    };
    return {
        ...view,
        loaded: note !== null,
        editable,
        fromRichEditor: note?.fromRichEditor ?? false,
        edit,
        /** Save now: the Retry after a failed save. */
        retry: () => void saver.save(),
        /** Add a chat answer to the end of the notes, as the web's "Insert into document". */
        append: (addition: string) => edit(appendToNote(saver.text, addition)),
    };
}

export type NoteDraft = ReturnType<typeof useNoteDraft>;
