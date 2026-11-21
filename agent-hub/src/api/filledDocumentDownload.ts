/**
 * Save a document filled in from a template in the chat as its rendered file:
 * a PDF, or a .pptx for a presentation (`GET /api/studio-documents/:id/pdf|pptx`,
 * which render the values the document keeps). Fetched rather than linked, as
 * the Documents page does: a bare <a href> would arrive without the session.
 */
import { apiRequest } from './typedRequest';

export type FilledDocumentFormat = 'pdf' | 'pptx';

/** A file name made of the document's name: no characters a file system or header would trip over. */
function fileNameOf(name: string, format: FilledDocumentFormat): string {
    const safe = Array.from(name).filter((ch) => /[\w\s.-]/.test(ch)).join('').trim();
    return `${safe || 'document'}.${format}`;
}

/** Download the rendered file; a refusal throws (RefusedError, with the server's text). */
export async function downloadFilledDocument(id: string, name: string, format: FilledDocumentFormat): Promise<void> {
    const res = format === 'pptx'
        ? await apiRequest('GET /api/studio-documents/{id}/pptx', { params: { id } })
        : await apiRequest('GET /api/studio-documents/{id}/pdf', { params: { id } });
    const url = URL.createObjectURL(await res.blob());
    try {
        const link = document.createElement('a');
        link.href = url;
        link.download = fileNameOf(name, format);
        document.body.appendChild(link);
        link.click();
        link.remove();
    } finally {
        // Chrome needs the object URL to outlive the click.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
