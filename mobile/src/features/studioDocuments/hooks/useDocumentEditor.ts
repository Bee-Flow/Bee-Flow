/**
 * The open document and everything that writes to it: the query, the one
 * write queue, the body's autosave, and the `epoch` that tells the text and
 * outline editors to start again from the stored body (after a restore, or
 * after a section was added to the body).
 */

import { useCallback, useState } from 'react';

import { useStudioDocument } from './queries';
import { useAutosave } from './useAutosave';
import { useDocumentWriter } from './useDocumentWriter';

export function useDocumentEditor(id: string) {
    const query = useStudioDocument(id);
    const write = useDocumentWriter(id);
    const saveBody = useCallback((bodyHtml: string) => write({ bodyHtml }), [write]);
    const autosave = useAutosave(saveBody);
    const [epoch, setEpoch] = useState(0);
    const reload = useCallback(() => setEpoch((n) => n + 1), []);
    return { query, doc: query.data ?? undefined, write, autosave, epoch, reload };
}

export type DocumentEditor = ReturnType<typeof useDocumentEditor>;
