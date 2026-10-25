import { useRef, useEffect, useCallback, useState, RefObject } from 'react';
import RichTextEditor from '../../editor/react/RichTextEditor.jsx';
import { API_BASE, authFetch } from '../../utils/helpers';
import { logger } from '../../utils/logger';
import { useTranslation } from '../../hooks/useTranslation';
import { renderMermaidToSVG, svgToPngDataUrl } from '../../pages/documents/notebook/MermaidBlock';
import type { WorkspaceNotebookProps } from './WorkspaceNotebook.types';
import { mutate, ApiError, errorBody, RefusedError } from '../../api/mutate';
import { type WorkspaceEditorHandle, embedImagesAsBase64 } from './WorkspaceNotebook.helpers';
import { WorkspaceNotebookSection } from './WorkspaceNotebookSection';

export default function WorkspaceNotebook({
    content,
    onChange,
    onSave,
    onClose,
    onSelectionChange,
    onAskAI,
    onOpenInNotebook,
    conversationId,
    existingNotebookId,
    onNotebookIdChange,
    user,
}: WorkspaceNotebookProps) {
    const editorRef = useRef<WorkspaceEditorHandle>(null);
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const [saving, setSaving] = useState(false);
    const saveTimerRef = useRef<NodeJS.Timeout>(null);

    // Lazy notebook creation for image uploads etc.
    const [notebookId, setNotebookId] = useState(existingNotebookId || null);
    const creatingNotebookRef = useRef(false);

    // Sync when the parent passes a different notebook id (e.g. conversation
    // switch). The `existingNotebookId &&` guard meant switching to a
    // conversation that has NO linked notebook kept the previous one's id — so
    // the next image upload and "Open in full notebook" pointed at another
    // conversation's document. Clearing is a legitimate transition.
    useEffect(() => {
        setNotebookId(existingNotebookId || null);
    }, [existingNotebookId, conversationId]);

    // Stable initial content. Mermaid needs no pre-pass — the editor's parsers
    // handle ```mermaid fences and legacy mermaid divs natively.
    const [initialContent] = useState(() => content || '');
    const prevContentRef = useRef(content);

    // Export state
    const [exporting, setExporting] = useState<string | null>(null);
    const [exportMenuOpen, setExportMenuOpen] = useState(false);
    const exportMenuRef = useRef<HTMLDivElement>(null);

    // Lazily create a real notebook when content exists
    const ensureNotebook = useCallback(async () => {
        if (notebookId || creatingNotebookRef.current) return notebookId;
        creatingNotebookRef.current = true;
        try {
            const res = await mutate(`${API_BASE}/api/notebooks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: `Chat Notebook – ${new Date().toLocaleDateString()}` }),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                const { notebook } = await res.json();
                setNotebookId(notebook.id);
                // Notify parent so it can persist the ID to the conversation
                onNotebookIdChange?.(notebook.id);
                // Trigger an immediate save so the notebook ID is persisted
                const editor = editorRef.current?.getEditor?.();
                const md = editor?.storage?.markdown?.getMarkdown?.() || '';
                if (md.trim()) onSave?.(md, notebook.id);
                return notebook.id;
            }
        } catch (err) {
            console.error('[WorkspaceNotebook] Failed to create notebook:', err);
        } finally {
            creatingNotebookRef.current = false;
        }
        return null;
    }, [notebookId, onNotebookIdChange, onSave]);

    // Auto-create notebook when content first appears
    useEffect(() => {
        if (content && content.trim() && !notebookId && !creatingNotebookRef.current) {
            ensureNotebook();
        }
    }, [content, notebookId, ensureNotebook]);

    // Push external updates imperatively. content from the chat notebook_write
    // tool is Markdown, so apply it through the editor's markdown setter. Crucial
    // fix: do NOT advance prevContentRef until the editor actually exists and the
    // content has been applied — on a cold open the editor isn't mounted yet, and
    // the old code advanced the ref then bailed, dropping the first update forever
    // so the notebook stayed empty after a confirmed write (BFSF-208). Retry until
    // the editor is ready.
    useEffect(() => {
        if (content === prevContentRef.current) return;
        let cancelled = false;
        let tries = 0;
        const apply = () => {
            if (cancelled) return;
            const handle = editorRef.current;
            const editor = handle?.getEditor?.();
            if (!editor) {
                if (tries++ < 40) setTimeout(apply, 50); // wait up to ~2s for mount
                return;
            }
            if (typeof (handle as NonNullable<typeof handle>).setMarkdownContent === 'function') {
                (handle as NonNullable<typeof handle> & { setMarkdownContent: (md: string) => void }).setMarkdownContent(content || '');
            } else {
                editor.commands.setContent(content || '', { emitUpdate: false });
            }
            prevContentRef.current = content; // only after a successful apply
        };
        apply();
        return () => { cancelled = true; };
    }, [content]);

    // Extract markdown helper
    const getMarkdown = useCallback(() => {
        const editor = editorRef.current?.getEditor?.();
        if (!editor) return '';
        return editor.storage.markdown?.getMarkdown?.() || '';
    }, []);

    // Get HTML for export
    const getHTML = useCallback(() => {
        const editor = editorRef.current?.getEditor?.();
        return editor?.getHTML?.() || '';
    }, []);

    // Editor onChange
    const handleEditorChange = useCallback(() => {
        const md = getMarkdown();
        prevContentRef.current = md;
        onChange?.(md);

        if (md.trim() && !notebookId && !creatingNotebookRef.current) {
            ensureNotebook();
        }

        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            setSaving(true);
            onSave?.(md);
            setTimeout(() => setSaving(false), 800);
        }, 1200);
    }, [onChange, onSave, getMarkdown, notebookId, ensureNotebook]);

    // AI actions from bubble menu — builds the final user-visible message here
    // (single source of truth) so the chat-owner callback is just a thin send.
    const handleAIAction = useCallback((actionKey: string, selectedText: string, range: unknown, customQuery: string) => {
        logger.debug('[Notebook AI] WorkspaceNotebook.handleAIAction:', { actionKey, hasOnAskAI: !!onAskAI, len: selectedText?.length });
        if (!onAskAI) {
            console.warn('[Notebook AI] aborted: onAskAI prop is missing in WorkspaceNotebook');
            return;
        }
        if (!selectedText || !selectedText.trim()) return;

        // Keep parent state in sync for the system-prompt context (separate
        // from message construction — AgentHub.getNotebookPayload reads this).
        onSelectionChange?.(selectedText);

        const quoted = selectedText.split('\n').map(line => `> ${line}`).join('\n');

        let instruction: string;
        switch (actionKey) {
            case 'rewrite':
                instruction = 'Please rewrite the selected text from the notebook above.';
                break;
            case 'shorten':
                instruction = 'Please shorten the selected text from the notebook above.';
                break;
            case 'expand':
                instruction = 'Please expand and elaborate on the selected text from the notebook above.';
                break;
            case 'ask': {
                const q = (customQuery || '').trim();
                instruction = q || 'Please answer questions about the selected text from the notebook above.';
                break;
            }
            default:
                instruction = `${actionKey}: please act on the selected text from the notebook above.`;
        }

        const message = `> **Selected text:**\n${quoted}\n\n${instruction}`;
        logger.debug('[Notebook AI] sending to chat, length:', message.length);
        onAskAI(message);
    }, [onAskAI, onSelectionChange]);

    // Copy
    const handleCopy = useCallback(() => {
        const md = getMarkdown();
        navigator.clipboard.writeText(md);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [getMarkdown]);

    // Export PDF/Word
    const handleExport = useCallback(async (format: string) => {
        const nbId = notebookId || await ensureNotebook();
        if (!nbId) return;

        setExporting(format);
        setExportMenuOpen(false);
        // The alt text of a rendered mermaid diagram in the export. It is interpolated
        // into an HTML string, so it must already be translated here. Inside that
        // string no t() is reachable.
        const diagramAlt = t('notebooks.diagram_alt', 'Diagram');
        try {
            let htmlContent = getHTML();

            // Render mermaid diagrams (data-code is base64 or HTML-entity encoded)
            const mermaidRegex = /<div[^>]*data-type="mermaid-diagram"[^>]*data-code="([^"]*?)"[^>]*>.*?<\/div>/gi;
            const mermaidMatches = [...htmlContent.matchAll(mermaidRegex)];
            for (const match of mermaidMatches) {
                // decodeFromAttr handles both base64 (new) and HTML-entity (legacy) formats
                let code: string;
                try {
                    code = decodeURIComponent(escape(atob(match[1])));
                } catch {
                    code = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
                }
                try {
                    const svg = await renderMermaidToSVG(code);
                    if (svg) {
                        const png = await svgToPngDataUrl(svg);
                        htmlContent = htmlContent.replace(match[0],
                            png ? `<div style="text-align:center;margin:16px 0;"><img src="${png}" style="max-width:100%;border-radius:8px;" alt="${diagramAlt}" /></div>`
                                : `<div style="text-align:center;margin:16px 0;">${svg}</div>`);
                    }
                } catch (err) { logger.debug('diagram could not be rendered to PNG, keep the original', err); }
            }

            htmlContent = await embedImagesAsBase64(htmlContent);

            let res: Response;
            try {
                res = await mutate(`${API_BASE}/api/notebooks/${nbId}/export/${format}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: htmlContent, title: 'Notebook' }),
            });
            } catch (apiErr) {
                if (!(apiErr instanceof RefusedError)) throw apiErr;
                const err = errorBody(apiErr) ?? {};
                throw new Error(err.error || `Export failed (${apiErr.status})`);
            }

            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `notebook-${new Date().toISOString().slice(0, 10)}.${format === 'pdf' ? 'pdf' : 'docx'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error('[WorkspaceNotebook] Export failed:', e);
        } finally {
            setExporting(null);
        }
    }, [notebookId, ensureNotebook, getHTML, t]);

    // Open in full notebook. The pane's text is synced first, as a
    // compare-and-set write over the version the notebook holds right now:
    // a newer save by somebody else (a colleague in a shared notebook, the
    // AI) is never overwritten — the server keeps this copy as a version
    // instead (409), and the notebook opens on the saved text.
    const handleOpenNotebook = useCallback(async () => {
        const md = getMarkdown();
        if (notebookId) {
            try {
                const cur = await authFetch(`${API_BASE}/api/notebooks/${notebookId}`);
                const data = cur.ok ? await cur.json().catch(() => null) : null;
                const nb = data?.notebook;
                const unchanged = nb && (nb.documentMd === md || nb.documentContent === md);
                if (nb && !unchanged && nb.role !== 'viewer') {
                    const body: { documentContent: string; expectedVersion?: number } = { documentContent: md };
                    if (Number.isFinite(nb.version)) body.expectedVersion = nb.version;
                    const res = await authFetch(`${API_BASE}/api/notebooks/${notebookId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                    if (!res.ok && res.status !== 409) console.warn('[WorkspaceNotebook] content sync before opening was refused:', res.status);
                }
            } catch (e) {
                console.warn('[WorkspaceNotebook] Failed to sync content before opening:', e);
            }
        }
        onOpenInNotebook?.(md, notebookId);
    }, [getMarkdown, onOpenInNotebook, notebookId]);

    // Close export menu on outside click
    useEffect(() => {
        if (!exportMenuOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node | null)) {
                setExportMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [exportMenuOpen]);

    /**
     * Flush the debounced save.
     *
     * This panel rolls its own 1.2 s debounce and simply cleared it on unmount,
     * so closing it (or navigating away) within 1.2 s of the last keystroke
     * dropped that text. It uses neither useDocumentAutosave nor
     * BeeEditor.flush(), which is why it missed the fix the other two surfaces
     * got. Refs keep the cleanup free of stale closures.
     */
    const flushSaveRef = useRef<() => void>(null);
    useEffect(() => {
        flushSaveRef.current = () => {
            if (!saveTimerRef.current) return;
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
            // Pull the very latest content from the editor, not the last value
            // the debounce happened to capture.
            const md = editorRef.current?.flush?.() != null ? getMarkdown() : prevContentRef.current;
            if (md != null && md !== '') onSave?.(md);
        };
    }, [getMarkdown, onSave]);

    useEffect(() => () => { flushSaveRef.current?.(); }, []);

    return (
        <div className="flex flex-col h-full bg-[var(--bg-primary)]">
            {/* ── Header Bar ── */}
            <WorkspaceNotebookSection t={t} saving={saving} user={user} exportMenuRef={exportMenuRef} setExportMenuOpen={setExportMenuOpen} exporting={exporting} exportMenuOpen={exportMenuOpen} handleExport={handleExport} handleOpenNotebook={handleOpenNotebook} flushSaveRef={flushSaveRef} onClose={onClose} />

            {/* ── TipTap Editor ── */}
            <WorkspaceNotebookSection2 editorRef={editorRef} initialContent={initialContent} handleEditorChange={handleEditorChange} onSave={onSave} getMarkdown={getMarkdown} handleAIAction={handleAIAction} saving={saving} notebookId={notebookId} user={user} />
        </div>
    );
}

function WorkspaceNotebookSection2({ editorRef, initialContent, handleEditorChange, onSave, getMarkdown, handleAIAction, saving, notebookId, user }: { editorRef: RefObject<WorkspaceEditorHandle | null>; initialContent: string; handleEditorChange: () => void; onSave: ((md: string, notebookId?: string) => unknown) | undefined; getMarkdown: () => string; handleAIAction: (actionKey: string, selectedText: string, range: unknown, customQuery: string) => void; saving: boolean; notebookId: string | null; user: { featureFlags?: { export?: boolean; openInNotebook?: boolean; askAi?: boolean;[key: string]: boolean | undefined; }; } | null | undefined; }) {
    return <div className="flex-1 min-h-0 overflow-hidden">
        <RichTextEditor
            ref={editorRef}
            content={initialContent}
            onChange={handleEditorChange}
            onSave={() => onSave?.(getMarkdown())}
            onAIAction={handleAIAction}
            saving={saving}
            notebookId={notebookId || 'workspace'}
            askAiEnabled={user?.featureFlags?.askAi !== false} />
    </div>;
}

