/**
 * What an attachment REALLY is, when its declared type is useless.
 *
 * Outlook labels a perfectly ordinary purchase-order PDF `application/octet-stream`,
 * and the App Studio readers (materializeAttachment, loadAttachment) route on
 * the mime. Two rules, in one place so they cannot drift:
 *
 *   - A generic or missing mime is PROPOSED from the filename extension
 *     (`proposeMimeFromName`, usable before any download) and CONFIRMED by the
 *     bytes (`sniffMime`).
 *   - The bytes win when they contradict the claim. A `.pdf` that does not start
 *     with `%PDF-` is not a PDF; a `.pdf` that is a PNG is an image.
 *
 * Only a bounded head of the file is looked at (HEAD_BYTES), never the whole.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { GENERIC_MIMES, cadMimeForName } = nodeRequire('../utils/cadTypes') as {
    GENERIC_MIMES: Set<string>;
    cadMimeForName: (name: unknown) => string | null;
};

const HEAD_BYTES = 1024;

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Extension (lowercase, no dot) to the mime it proposes. */
const MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    docx: DOCX,
    xlsx: XLSX,
    pptx: PPTX,
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    txt: 'text/plain',
    csv: 'text/csv',
});

const ZIP_OFFICE = new Set([DOCX, XLSX, PPTX]);
const OLE_MIME = new Set(['application/msword', 'application/vnd.ms-excel']);

/** True for a missing, empty or "says nothing" mime. */
export function isGenericMime(mime: unknown): boolean {
    return GENERIC_MIMES.has(String(mime ?? '').split(';')[0].trim().toLowerCase());
}

function extensionOf(name: unknown): string {
    const base = String(name ?? '').slice(-260);
    const dot = base.lastIndexOf('.');
    return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * The mime the filename proposes for a GENERIC declared mime, else the declared
 * mime unchanged. A proposal only: the bytes still have to confirm it.
 */
export function proposeMimeFromName(name: unknown, mime: unknown): string {
    const declared = String(mime ?? '').split(';')[0].trim().toLowerCase();
    if (!isGenericMime(declared)) return declared;
    return cadMimeForName(name) || MIME_BY_EXT[extensionOf(name)] || declared;
}

type Family = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'zip' | 'ole' | 'text' | null;

function familyOf(head: Uint8Array): Family {
    const at = (i: number): number => (i < head.length ? head[i] : -1);
    const starts = (sig: number[], offset = 0): boolean => sig.every((b, i) => at(offset + i) === b);
    // PDF readers tolerate junk before the header; the spec allows 1024 bytes.
    if (Buffer.from(head.subarray(0, HEAD_BYTES)).includes('%PDF-')) return 'pdf';
    if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (starts([0xff, 0xd8, 0xff])) return 'jpeg';
    if (starts([0x47, 0x49, 0x46, 0x38])) return 'gif';
    if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
    if (starts([0x50, 0x4b, 0x03, 0x04])) return 'zip';
    if (starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
    return null;
}

function looksLikeText(head: Uint8Array): boolean {
    const n = Math.min(head.length, 512);
    if (n === 0) return false;
    for (let i = 0; i < n; i++) if (head[i] === 0) return false;
    return true;
}

const MIME_BY_FAMILY: Readonly<Record<string, string>> = Object.freeze({
    pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
});

/**
 * The best mime for these bytes. `mime` is what the sender declared, `name` the
 * filename. Returns the declared mime (lowercased, parameters dropped) when the
 * bytes say nothing that contradicts it and nothing can be proposed.
 */
export function sniffMime(bytes: Uint8Array, { name, mime }: { name?: unknown; mime?: unknown } = {}): string {
    const declared = String(mime ?? '').split(';')[0].trim().toLowerCase();
    const head = bytes.subarray(0, HEAD_BYTES);
    const family = familyOf(head);
    const ext = extensionOf(name);
    const proposed = proposeMimeFromName(name, declared);

    if (family && family in MIME_BY_FAMILY) return MIME_BY_FAMILY[family];
    if (family === 'zip') {
        if (ZIP_OFFICE.has(proposed)) return proposed;
        return 'application/zip';
    }
    if (family === 'ole') return OLE_MIME.has(proposed) ? proposed : 'application/x-ole-storage';
    // No binary signature. A generic mime stays generic unless the extension
    // names a text-shaped format the bytes do not contradict.
    if (isGenericMime(declared)) {
        const cad = cadMimeForName(name);
        if (cad) return cad;
        if ((ext === 'txt' || ext === 'csv') && looksLikeText(head)) return proposed;
        return declared || 'application/octet-stream';
    }
    return declared;
}
