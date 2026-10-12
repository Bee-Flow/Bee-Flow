/**
 * Small pieces of the open notebook's behaviour, kept out of the view:
 *
 *   useMarkNotebookSeen a project notebook that stayed open for a moment
 *                       counts as seen (its unread dot in the project clears)
 *   useNotebookShortcuts ⌥⌘H history, ⌥⌘M comments
 *   isEmptyDocument     nothing but empty paragraphs
 */
import { useEffect, useRef } from 'react';
import { useMarkItemSeen } from '../../../../api/queries/projectChanges';

const SEEN_AFTER_MS = 3000;

export function useMarkNotebookSeen(projectId: string | null, notebookId: string) {
    const { mutate } = useMarkItemSeen(projectId || '');
    useEffect(() => {
        if (!projectId) return undefined;
        const timer = setTimeout(() => mutate({ type: 'notebook', id: notebookId }), SEEN_AFTER_MS);
        return () => clearTimeout(timer);
    }, [projectId, notebookId, mutate]);
}

export function useNotebookShortcuts(handlers: { onHistory?: () => void; onComments?: () => void }) {
    const latest = useRef(handlers);
    useEffect(() => { latest.current = handlers; });
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
            // `code` survives the Option key's character remapping on a Mac.
            if (e.code === 'KeyH' && latest.current.onHistory) { e.preventDefault(); latest.current.onHistory(); }
            else if (e.code === 'KeyM' && latest.current.onComments) { e.preventDefault(); latest.current.onComments(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
}

/** True for a document with no text and nothing embedded (images, tables, diagrams). */
export function isEmptyDocument(html: string | null | undefined): boolean {
    const s = String(html || '');
    if (/<(img|table|hr|iframe|svg)\b|data-type=/i.test(s)) return false;
    return !s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}
