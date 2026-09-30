/**
 * useImportFile — "Import a file" into the open notebook: the file is parsed
 * on the server and inserted at the cursor (as HTML, so a Word file keeps its
 * headings and lists). A failure is reported to the page's notice.
 */
import { useCallback, useRef, type ChangeEvent, type MutableRefObject } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import useTranslation from '../../../hooks/useTranslation';
import type { NotebookEditorHandle } from './editorHandle';

export function useImportFile(notebookId: string, editorRef: MutableRefObject<NotebookEditorHandle | null>, onError: (message: string) => void) {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const open = useCallback(() => inputRef.current?.click(), []);
    const onChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const form = new FormData();
            form.append('file', file);
            const res = await authFetch(`${API_BASE}/api/notebooks/${notebookId}/import-file`, { method: 'POST', body: form });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t('notebooks.import_failed', 'The file could not be read.'));
            if (data.text) editorRef.current?.insertContent?.(data.text);
        } catch (err) {
            onError(t('notebooks.import_error', 'Import failed: {message}', { message: (err as Error).message }));
        }
    }, [editorRef, notebookId, onError, t]);
    return { inputRef, open, onChange };
}
