/**
 * useNotebookExports — PDF / Word download, send for signing and save to
 * Nextcloud for the open notebook.
 *
 * The page builds the export HTML (Mermaid diagrams rendered to images,
 * images inlined) and the server turns it into the file. Outcomes land in the
 * page's one notice (`onNotice`): a failure says why, a Nextcloud save links
 * to its folder. Signing reports inside its own dialog.
 */
import { useCallback, useState } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { embedImagesAsBase64 } from '../../../../utils/imageEmbedding';
import { renderMermaidToSVG, svgToPngDataUrl } from '../MermaidBlock';
import useTranslation, { type TranslateFn } from '../../../../hooks/useTranslation';

export interface NotebookNotice { kind: 'error' | 'success' | 'info'; message: string; link?: { href: string; label: string } | null }

interface Options {
    notebookId: string;
    title: string;
    /** The content to export: the document, or (for an empty one) the last answer. */
    getContent: () => string;
    onNotice: (notice: NotebookNotice | null) => void;
}

const MERMAID_DIV = /<div[^>]*data-type="mermaid-diagram"[^>]*data-code="([^"]*?)"[^>]*>.*?<\/div>/gi;

function decodeMermaid(encoded: string): string {
    try {
        return new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
    } catch {
        return encoded.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    }
}

/** A file name that keeps letters in any script, and loses only what file systems refuse. */
export function exportFileName(title: string, ext: string): string {
    const clean = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${clean || 'notebook'}.${ext}`;
}

/** Server error codes whose sentence the client translates (server/i18n/defaults/en/notebooks.js). */
const TRANSLATED_CODES: Record<string, string> = {
    pdf_renderer_unavailable: 'notebooks.pdf_renderer_unavailable',
    pdf_render_timeout: 'notebooks.pdf_render_timeout',
};

/** The sentence for a failed export: a known code in the user's language, else the server's words. */
export function exportErrorText(body: unknown, t: TranslateFn, fallback: string): string {
    const { error, code, correlationId } = (body || {}) as { error?: string; code?: string; correlationId?: string };
    const key = code ? TRANSLATED_CODES[code] : undefined;
    const message = key ? t(key, error || fallback) : (error || fallback);
    // A generic failure carries a reference the administrator can find in the server log.
    if (correlationId && !key) {
        return t('notebooks.export_error_ref', '{message} (ref: {ref})', { message, ref: correlationId });
    }
    return message;
}

async function readError(res: Response, t: TranslateFn, fallback: string): Promise<Error> {
    const body = await res.json().catch(() => ({}));
    return new Error(exportErrorText(body, t, fallback));
}

export default function useNotebookExports({ notebookId, title, getContent, onNotice }: Options) {
    const { t } = useTranslation();
    const [exporting, setExporting] = useState<string | null>(null);
    const [signSending, setSignSending] = useState(false);
    const [signError, setSignError] = useState<string | null>(null);
    const [nextcloudExporting, setNextcloudExporting] = useState(false);

    const post = useCallback((path: string, body: unknown) => authFetch(`${API_BASE}/api/notebooks/${notebookId}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }), [notebookId]);

    const handleExport = useCallback(async (format: 'pdf' | 'docx') => {
        let content = getContent();
        if (!content) return;
        setExporting(format);
        try {
            let failures = 0;
            for (const match of [...content.matchAll(MERMAID_DIV)]) {
                try {
                    const svg = await renderMermaidToSVG(decodeMermaid(match[1]));
                    if (!svg) continue;
                    const png = await svgToPngDataUrl(svg);
                    content = content.replace(match[0], png
                        ? `<div style="text-align:center;margin:16px 0;"><img src="${png}" style="max-width:100%;border-radius:8px;" alt="Diagram" /></div>`
                        : `<div style="text-align:center;margin:16px 0;">${svg}</div>`);
                } catch (err) {
                    console.error('[Notebooks] Mermaid export render failed:', err);
                    failures += 1;
                }
            }
            content = await embedImagesAsBase64(content);
            const res = await post(`/export/${format}`, { content, title });
            if (!res.ok) throw await readError(res, t, t('notebooks.export_failed_status', 'Export failed ({status})', { status: res.status }));
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = exportFileName(title, format === 'pdf' ? 'pdf' : 'docx');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            // Diagrams that dropped out of the file are said, not discovered later.
            onNotice(failures > 0
                ? { kind: 'error', message: t('notebooks.export_mermaid_failed', 'Exported, but {count} diagram(s) could not be rendered and were skipped.', { count: failures }) }
                : null);
        } catch (e) {
            console.error('[Notebooks] Export failed:', e);
            onNotice({ kind: 'error', message: (e as Error).message });
        } finally {
            setExporting(null);
        }
    }, [getContent, post, title, onNotice, t]);

    const handleSendForSigning = useCallback(async ({ signers, subject, message }: { signers: unknown; subject?: string; message?: string }) => {
        const raw = getContent();
        if (!raw) return null;
        setSignSending(true);
        try {
            const content = await embedImagesAsBase64(raw);
            const res = await post('/export/signrequest', { content, title, signers, subject, message });
            if (!res.ok) throw await readError(res, t, t('notebooks.sign_failed_status', 'Sending for signing failed ({status})', { status: res.status }));
            return await res.json();
        } catch (e) {
            // Inside the dialog: a banner behind its backdrop would go unseen.
            setSignError((e as Error).message);
            return null;
        } finally {
            setSignSending(false);
        }
    }, [getContent, post, title, t]);

    const handleNextcloudExport = useCallback(async () => {
        const raw = getContent();
        if (!raw) return;
        setNextcloudExporting(true);
        onNotice(null);
        try {
            const content = await embedImagesAsBase64(raw);
            const res = await post('/export/nextcloud', { content, title });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(exportErrorText(data, t, t('notebooks.nextcloud_failed_status', 'Saving to Nextcloud failed ({status})', { status: res.status })));
            onNotice({
                kind: 'success',
                message: t('notebooks.nextcloud_saved', 'Saved to Nextcloud: {path}', { path: data.path || '' }),
                link: data.folderUrl ? { href: data.folderUrl, label: t('notebooks.open_folder', 'Open folder') } : null,
            });
        } catch (e) {
            onNotice({ kind: 'error', message: (e as Error).message });
        } finally {
            setNextcloudExporting(false);
        }
    }, [getContent, post, title, onNotice, t]);

    return {
        exporting, handleExport,
        signSending, signError, clearSignError: () => setSignError(null), handleSendForSigning,
        nextcloudExporting, handleNextcloudExport,
    };
}
