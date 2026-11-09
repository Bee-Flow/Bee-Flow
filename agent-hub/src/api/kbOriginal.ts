import { API_BASE, authFetch } from '@/utils/helpers';
import { logger } from '@/utils/logger';

/** What a refused download throws: the server's text plus its machine-readable code. */
interface OriginalDownloadError extends Error {
    status?: number;
    code?: string | null;
}

/** The file name from a `Content-Disposition` header (RFC 5987 `filename*` first), or null. */
function nameFromDisposition(header: string | null): string | null {
    if (!header) return null;
    const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
    if (star) {
        try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch (err) { logger.debug('undecodable filename*', err); }
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain ? plain[1].trim() : null;
}

/**
 * Save the ORIGINAL file of a knowledge-base document through the browser's
 * download (`GET /api/kb/:kbId/documents/:docId/original`).
 *
 * A refusal throws an error carrying `.code` (`no_original` when the base did
 * not keep the file, `cloud_not_connected` when it has to be fetched again from
 * a cloud the reader has not connected) so the caller can say which.
 */
export async function downloadKbOriginal(kbId: string, docId: string, fallbackName: string): Promise<void> {
    const res = await authFetch(`${API_BASE}/api/kb/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/original`);
    if (!res.ok) {
        let body: { error?: unknown; code?: unknown } | null = null;
        try { body = await res.json(); } catch (err) { logger.debug('non-JSON error body', err); }
        const err: OriginalDownloadError = new Error(typeof body?.error === 'string' ? body.error : `Download failed (${res.status})`);
        err.status = res.status;
        err.code = typeof body?.code === 'string' ? body.code : null;
        throw err;
    }
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = nameFromDisposition(res.headers.get('Content-Disposition')) || fallbackName;
    link.click();
    // Chrome needs the object URL to outlive the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
