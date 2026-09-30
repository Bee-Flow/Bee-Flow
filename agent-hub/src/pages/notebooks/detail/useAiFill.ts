/**
 * useAiFill — fill the document's {{parameters}} from the notebook's sources.
 *
 * The server streams the filled document; it is applied through the editor
 * (so it is saved like typing, or shared like typing while co-editing). A
 * stream that ends without content, or with an error event, is reported
 * instead of quietly doing nothing.
 */
import { useCallback, useState, type MutableRefObject } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import useTranslation from '../../../hooks/useTranslation';
import type { NotebookEditorHandle } from './editorHandle';
import { editorHtml } from './editorHandle';

interface Options {
    notebookId: string;
    modelTier: string;
    editorRef: MutableRefObject<NotebookEditorHandle | null>;
    onError: (message: string) => void;
    /** The filled document is in the editor (HTML): save it (a live session shares it by itself). */
    onApplied: (html: string) => void;
}

/** Read an SSE body into the text of its `content` events; an `error` event throws. */
export async function readFillStream(body: ReadableStream<Uint8Array>, fallbackError: string): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let filled = '';
    let event = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('event: ')) { event = line.slice(7).trim(); continue; }
            if (!line.startsWith('data: ')) continue;
            let data: { text?: string; error?: string };
            try { data = JSON.parse(line.slice(6)); } catch { continue; }   // a partial frame
            if (event === 'content' && data.text) filled += data.text;
            else if (event === 'error') throw new Error(data.error || fallbackError);
        }
    }
    return filled;
}

export default function useAiFill({ notebookId, modelTier, editorRef, onError, onApplied }: Options) {
    const { t } = useTranslation();
    const [aiFilling, setAiFilling] = useState(false);

    const handleAIFill = useCallback(async () => {
        if (aiFilling) return;
        const html = editorHtml(editorRef.current);
        if (!html?.trim()) return;
        if (!/\{\{[^}]+\}\}/.test(html)) {
            onError(t('notebooks.ai_fill_no_params', 'No {{parameters}} found in the document to fill.'));
            return;
        }
        setAiFilling(true);
        try {
            const res = await authFetch(`${API_BASE}/api/notebooks/${notebookId}/ai-fill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentContent: html, modelTier }),
            });
            if (!res.ok || !res.body) {
                const err = await res.json().catch(() => ({}));
                throw new Error((err as { error?: string }).error || t('notebooks.ai_fill_failed', 'AI Fill failed'));
            }
            const filled = await readFillStream(res.body, t('notebooks.ai_fill_failed', 'AI Fill failed'));
            if (!filled.trim()) throw new Error(t('notebooks.ai_fill_no_content', 'AI Fill returned no content. Please try again.'));
            // One undoable step: Ctrl+Z brings the unfilled document back. The
            // snapshot it was made from keeps what co-editors typed meanwhile.
            const handle = editorRef.current;
            if (handle?.replaceDocument) handle.replaceDocument(filled, { markdown: true, base: html });
            else handle?.setMarkdown?.(filled);
            const applied = editorHtml(editorRef.current);
            if (applied != null) onApplied(applied);
        } catch (e) {
            onError((e as Error).message);
        } finally {
            setAiFilling(false);
        }
    }, [aiFilling, editorRef, modelTier, notebookId, onError, onApplied, t]);

    return { aiFilling, handleAIFill };
}
