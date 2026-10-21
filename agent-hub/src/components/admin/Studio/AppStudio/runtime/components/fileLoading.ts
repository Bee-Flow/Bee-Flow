import { studioFilesApi } from '../../../../../../api/studioFilesApi';
import { entryHref, entryName } from './AppInputFile';

/**
 * Shared file loading for the App Studio components that show a stored file
 * (file_preview, pdf_compare). Everything goes through authFetch — the demo-mode
 * choke point — and ends as a same-origin blob, never a raw cross-origin src.
 */

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** A file descriptor as stored in a `file` column (or a legacy bare URL string). */
export type FileEntry = string | { kind?: string; fileId?: string; attachmentId?: string; recordId?: string; name?: string; mime?: string } | null;

/**
 * The first descriptor a binding resolved to — one file, no carousel.
 *
 * A `file` column is stored as JSON TEXT and nothing parses it on the read
 * path, so a records binding hands this component the raw string. Treating that
 * as a legacy URL is what rendered a filename like
 * `pdf\",\"size\":231504,\"isInline\":false}` — the tail of the JSON, split on
 * a slash.
 */
export function firstDescriptor(value: unknown): FileEntry {
    let v: unknown = Array.isArray(value) ? value[0] : value;
    if (!v) return null;
    // Bounded unwrap, not a single parse: rows written while the connector
    // pre-stringified descriptors are DOUBLE-encoded — text starting with `"`
    // whose first parse yields another string. One parse returned that string,
    // nothing downstream saw a descriptor, and the preview never even asked
    // the server for the bytes.
    for (let i = 0; i < 3 && typeof v === 'string'; i++) {
        const s = v.trim();
        if (!s.startsWith('{') && !s.startsWith('[') && !s.startsWith('"')) {
            return s;                                   // legacy bare URL
        }
        try {
            const parsed = JSON.parse(s);
            v = Array.isArray(parsed) ? parsed[0] : parsed;
        } catch { return s; }                           // not JSON → legacy bare URL
    }
    return (v && typeof v === 'object') ? (v as FileEntry) : null;
}

/** The identity of the file being shown, as a string an effect can depend on. */
export function descriptorKey(descriptor: FileEntry): string | null {
    if (!descriptor) return null;
    if (typeof descriptor === 'string') return descriptor;
    return `${descriptor.kind}:${descriptor.fileId || descriptor.attachmentId || ''}:${descriptor.recordId || ''}`;
}

export function friendlyError(status: number | undefined, message: string | undefined, t: Translate): string {
    if (status === 404) return t('studio_apps_runtime.file_preview.no_access', 'You do not have access to this file.');
    if (status === 403) return t('studio_apps_runtime.file_preview.no_access', 'You do not have access to this file.');
    if (status === 409) return t('studio_apps_runtime.file_preview.storage_full', "This app's file storage is full — ask the owner to clean up.");
    if (status === 413) return t('studio_apps_runtime.file_preview.too_large', 'That file is too large to open here.');
    if (status === 415) return t('studio_apps_runtime.file_preview.type_unsupported', 'That file type cannot be shown.');
    if (status === 422) return t('studio_apps_runtime.file_preview.malware', 'That file did not pass the malware scan.');
    return message || t('studio_apps_runtime.file_preview.open_failed', 'Could not open this file.');
}

/** A pending mailbox pointer has no bytes of its own yet: redeem it into a stored file. */
export async function materializeEntry(entry: FileEntry, appId: string): Promise<FileEntry> {
    if (entry && typeof entry === 'object' && entry.kind === 'mailbox_attachment') {
        const res = await studioFilesApi.materialize(appId, entry.attachmentId);
        const body = await res.json().catch(() => null);
        if (!res.ok) throw Object.assign(new Error(body?.error || ''), { status: res.status });
        return body?.attachment;
    }
    return entry;
}

export interface LoadedFile { blob: Blob; name: string; mime: string }

/** Resolve a descriptor to its bytes. Throws an Error carrying `.status` on failure. */
export async function fetchFileBlob(descriptor: FileEntry, appId: string): Promise<LoadedFile> {
    const entry = await materializeEntry(descriptor, appId);
    const href = entryHref(entry, appId);
    if (!href) throw Object.assign(new Error('That file cannot be opened.'), { status: 415 });
    const res = await studioFilesApi.fetchHref(href);
    if (!res.ok) throw Object.assign(new Error(''), { status: res.status });
    const blob = await res.blob();
    const mime = (entry && typeof entry === 'object' && entry.mime) || blob.type || 'application/octet-stream';
    return { blob, name: entryName(entry), mime };
}
