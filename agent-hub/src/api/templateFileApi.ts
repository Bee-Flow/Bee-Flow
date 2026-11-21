/**
 * A template as a `.bftemplate` file, Bee Flow's own template format
 * (server/core/documents/templateFile.mts): download one, and import one as a
 * new private template.
 *
 *   GET  /api/studio-documents/:id/export  the file (the server names it)
 *   POST /api/studio-documents/import      { file, folderId? } → { document }
 */
import { apiJson, apiRequest } from './typedRequest';

const TEMPLATE_FILE_EXTENSION = '.bftemplate';
/** What the file picker offers: the extension, and the type a browser may report for it. */
export const TEMPLATE_FILE_ACCEPT = '.bftemplate,application/vnd.beeflow.template+json';

/** Thrown when a picked file is not readable as a template file at all (before the server sees it). */
export class TemplateFileError extends Error {}

/** The file name the server sent (Content-Disposition), or one made of the template's name. */
function fileNameOf(res: Response, name: string): string {
    const header = res.headers.get('content-disposition') || '';
    const marker = 'filename="';
    const at = header.indexOf(marker);
    if (at >= 0) {
        const end = header.indexOf('"', at + marker.length);
        if (end > at) return header.slice(at + marker.length, end);
    }
    const safe = Array.from(name).filter((ch) => /[\w\s.-]/.test(ch)).join('').trim();
    return `${safe || 'template'}${TEMPLATE_FILE_EXTENSION}`;
}

/** Download a template as a .bftemplate file. Resolves with how many pictures could not be put in. */
export async function exportTemplateFile(id: string, name: string): Promise<{ skippedImages: number }> {
    const res = await apiRequest('GET /api/studio-documents/{id}/export', { params: { id } });
    const url = URL.createObjectURL(await res.blob());
    try {
        const link = document.createElement('a');
        link.href = url;
        link.download = fileNameOf(res, name);
        document.body.appendChild(link);
        link.click();
        link.remove();
    } finally {
        // Chrome needs the object URL to outlive the click.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return { skippedImages: Number(res.headers.get('x-skipped-images')) || 0 };
}

/** Import a picked .bftemplate file as a new private template; the server checks it and says what is wrong. */
export async function importTemplateFile(file: File, folderId?: string): Promise<{ id: string; name: string }> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        throw new TemplateFileError('not_json');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TemplateFileError('not_json');
    const body = await apiJson<'POST /api/studio-documents/import', { document?: { id?: string; name?: string } }>(
        'POST /api/studio-documents/import',
        { body: { file: parsed as Record<string, unknown>, ...(folderId ? { folderId } : {}) } },
    );
    return { id: String(body.document?.id || ''), name: String(body.document?.name || '') };
}
