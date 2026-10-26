// A Studio document reference as a binding resolves to it — the same shapes the
// server accepts (server/appStudio/appDocuments/pool.mts parseDocumentRef):
// "id", "id@versionId", { documentId, versionId? } (copy_document's result) or
// { id }. A list (a record field holding several) takes its first entry.

import type { DocumentRef } from '../../../../../../../api/queries/studioAppDocuments';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function fromString(value: string): DocumentRef | null {
    const [id, version] = value.trim().split('@');
    if (!id || !ID_RE.test(id)) return null;
    if (version !== undefined && !ID_RE.test(version)) return null;
    return { documentId: id, versionId: version || null };
}

function fromObject(o: Record<string, unknown>): DocumentRef | null {
    const id = typeof o.documentId === 'string' ? o.documentId : (typeof o.id === 'string' ? o.id : '');
    if (!ID_RE.test(id)) return null;
    const version = typeof o.versionId === 'string' && ID_RE.test(o.versionId) ? o.versionId : null;
    return { documentId: id, versionId: version };
}

export function parseDocumentRef(value: unknown): DocumentRef | null {
    if (Array.isArray(value)) return value.length ? parseDocumentRef(value[0]) : null;
    if (typeof value === 'string') return fromString(value);
    if (value && typeof value === 'object') return fromObject(value as Record<string, unknown>);
    return null;
}

/** Do both references name the same document with no revision chosen on either side? */
export function sameDocument(a: DocumentRef | null, b: DocumentRef | null): boolean {
    return !!a && !!b && a.documentId === b.documentId && !a.versionId && !b.versionId;
}
