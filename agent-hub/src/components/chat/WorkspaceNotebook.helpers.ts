import type { NotebookEditorFacade, NotebookEditorHandle } from '../../pages/documents/notebook/detail/editorHandle';

/** The editor ref as this panel uses it: the facade also carries TipTap's storage and commands. */
export interface WorkspaceEditorHandle extends NotebookEditorHandle {
    getEditor?: () => (NotebookEditorFacade & {
        storage: { markdown?: { getMarkdown?: () => string } };
        commands: { setContent: (content: string, options?: { emitUpdate?: boolean }) => void };
    }) | null;
    setMarkdownContent?: (md: string) => void;
}

/* ── Embed images as base64 for export ───────────────────────── */
export async function embedImagesAsBase64(html: string) {
    const imgRegex = /<img([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi;
    const matches = [...html.matchAll(imgRegex)];
    const replacements = await Promise.allSettled(
        matches.map(async (match) => {
            const [fullMatch, before, src, after] = match;
            if (src.startsWith('data:')) return { fullMatch, newTag: fullMatch };
            try {
                const resolvedUrl = src.startsWith('http') ? src : `${window.location.origin}${src}`;
                const res = await fetch(resolvedUrl, { credentials: 'include' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                let widthStyle = '';
                const widthMatch = (before + after).match(/data-width=["'](\d+)["']/);
                const styleMatch = (before + after).match(/style=["']([^"']*?width[^"']*?)["']/);
                if (widthMatch) widthStyle = ` style="width:${widthMatch[1]}px;height:auto;max-width:100%"`;
                else if (styleMatch) widthStyle = ` style="${styleMatch[1]}"`;
                return { fullMatch, newTag: `<img src="${dataUrl}"${widthStyle} alt="" />` };
            } catch (err) {
                console.warn('[Export] Failed to embed image:', src, (err as Error).message);
                return { fullMatch, newTag: fullMatch };
            }
        })
    );
    let result = html;
    for (const r of replacements) {
        if (r.status === 'fulfilled') result = result.replace(r.value.fullMatch, r.value.newTag);
    }
    return result;
}
