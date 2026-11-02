import { fetchFileBlob, firstDescriptor } from './fileLoading';

/**
 * Types a new tab may show. An allowlist: a blob opened top-level runs in the
 * app's own origin, so HTML and SVG (which can carry script) are downloaded,
 * never shown.
 */
const VIEWABLE = /^(application\/pdf|text\/plain|image\/(png|jpe?g|gif|webp|avif))$/i;

/** Keep the object URL alive long enough for the new tab / download to read it. */
const REVOKE_AFTER_MS = 60_000;

/** The file descriptor a row carries in `fileKey`, or null when it has none. */
export function rowFile(row: unknown, fileKey: string | null | undefined, read: (row: unknown, key: string) => unknown) {
    if (!fileKey || !row || typeof row !== 'object') return null;
    return firstDescriptor(read(row, fileKey));
}

/**
 * Fetch a stored file and show it in a new tab, or download it when the browser
 * cannot show the type. Throws an Error carrying `.status` on failure.
 */
export async function openStoredFile(descriptor: ReturnType<typeof firstDescriptor>, appId: string): Promise<void> {
    const { blob, name, mime } = await fetchFileBlob(descriptor, appId);
    const viewable = VIEWABLE.test(mime);
    const typed = viewable && blob.type !== mime ? new Blob([blob], { type: mime }) : blob;
    const url = URL.createObjectURL(typed);
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
    if (viewable) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
}
