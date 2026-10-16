// Revisions of the CMS documents (optimistic concurrency).
//
// Every page and the site chrome carry a `rev` that the server raises on each
// save. A save must name the rev it is based on; when somebody else saved in
// between, the server answers 409 `cms_conflict` instead of overwriting them.
export const CONFLICT_CODE = 'cms_conflict';

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The revision a document carries, 0 when it has none. */
export function revOf(doc: unknown): number {
    return isRecord(doc) && typeof doc.rev === 'number' ? doc.rev : 0;
}

/** `doc` with its revision replaced; anything that is not an object passes through. */
export function withRev(doc: unknown, rev: number): unknown {
    return isRecord(doc) ? { ...doc, rev } : doc;
}

/** The revision the server stored, from a save answer shaped `{ page }` or `{ site }`. */
export function storedRev(answer: unknown, field: 'page' | 'site'): number | null {
    if (!isRecord(answer)) return null;
    const doc = answer[field];
    return isRecord(doc) && typeof doc.rev === 'number' ? doc.rev : null;
}

/** A save the server refused because the document changed elsewhere meanwhile. */
export class SaveConflictError extends Error {}

// The revision each document had after OUR last successful save, per site and
// key ("site" or a page id). The panel state still holds the revision it
// loaded, so the next save of the same document takes the larger of the two; a
// revision loaded after somebody else's save is larger still and wins. One
// editor per tab, so this is module state shared by the autosave and the
// page-settings save (which also raises a page's revision).
const savedRevs = new Map<string, number>();

/** Record the revision the server stored for `key`. */
export function noteSavedRev(siteId: string, key: string, rev: unknown): void {
    if (typeof rev !== 'number') return;
    const slot = `${siteId}:${key}`;
    savedRevs.set(slot, Math.max(savedRevs.get(slot) ?? 0, rev));
}

/** The revision to name in the next save of `key`: ours after the last save, or the loaded one, whichever is newer. */
export function revisionFor(siteId: string, key: string, doc: unknown): number {
    return Math.max(savedRevs.get(`${siteId}:${key}`) ?? 0, revOf(doc));
}

/** Forget every recorded revision (tests). */
export function resetSavedRevs(): void {
    savedRevs.clear();
}
