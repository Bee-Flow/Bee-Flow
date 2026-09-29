/**
 * Which DOCUMENT a cited passage came from.
 *
 * `msg.kbSources` holds one entry per PASSAGE, on purpose: the client merge in
 * `hooks/useChatEngine/sseEvents.ts` keeps several passages of one document,
 * because the "How I got this answer" panel lists them. The chip row under the
 * answer used to render that list as-is, one chip per passage, and with the
 * label truncated a handful of meeting notes read as ten identical chips: it
 * looked like the same notes had been fetched over and over (BFSF-352).
 *
 * This is the one grouping the chip row, the sources panel and the count pill
 * share, so the three never disagree about how many documents an answer used.
 * It changes what is SHOWN, never what was retrieved.
 *
 * The key, most specific first:
 *   1. a live table row (`datatableId` + `rowId`) is its own source;
 *   2. the documents row, `documentId`, or `document_id` as the agent
 *      project-KB path and older stored messages send it;
 *   3. the title plus the day the thing happened, so two meetings that share a
 *      title stay two;
 *   4. the title alone.
 * A passage with none of these lands in one "unknown" group, which is how the
 * sources panel has always grouped an untitled passage.
 */

/** The fields this grouping reads. Every one of them may be absent. */
export interface CitedSource {
    title?: unknown;
    content?: unknown;
    score?: unknown;
    documentId?: unknown;
    document_id?: unknown;
    datatableId?: unknown;
    rowId?: unknown;
    occurredAt?: unknown;
}

/** One document and the passages of it this answer cited. */
export interface CitationGroup<T> {
    key: string;
    /** The passage a chip opens: the most relevant one that can be opened. */
    best: T;
    /** Every passage, in retrieval order. */
    passages: T[];
}

function text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

/** An id as either a non-empty string or a number, or null. */
function idOf(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return text(value);
}

export function documentKeyOf(source: CitedSource | null | undefined): string {
    if (!source || typeof source !== 'object') return 'unknown';
    const tableId = idOf(source.datatableId);
    const rowId = idOf(source.rowId);
    if (tableId && rowId) return `row:${tableId}:${rowId}`;
    const documentId = idOf(source.documentId) ?? idOf(source.document_id);
    if (documentId) return `doc:${documentId}`;
    const title = text(source.title);
    if (!title) return 'unknown';
    const when = text(source.occurredAt);
    return when ? `title:${title}\u0000${when}` : `title:${title}`;
}

function scoreOf(source: CitedSource): number {
    return typeof source.score === 'number' && Number.isFinite(source.score) ? source.score : -Infinity;
}

function openable(source: CitedSource): boolean {
    return text(source.content) !== null;
}

/**
 * Is `candidate` a better passage to open than `current`? A passage that can
 * be opened always beats one that cannot (an agent project-KB citation carries
 * only a snippet); after that the higher score wins, and a tie keeps the
 * earlier, higher-ranked one.
 */
function betterThan(candidate: CitedSource, current: CitedSource): boolean {
    const a = openable(candidate);
    const b = openable(current);
    if (a !== b) return a;
    return scoreOf(candidate) > scoreOf(current);
}

/** Group passages by document, in the order each document first appears. */
export function groupByDocument<T extends CitedSource>(sources: ReadonlyArray<T | null | undefined>): CitationGroup<T>[] {
    const groups = new Map<string, CitationGroup<T>>();
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        const key = documentKeyOf(source);
        const group = groups.get(key);
        if (!group) {
            groups.set(key, { key, best: source, passages: [source] });
            continue;
        }
        group.passages.push(source);
        if (betterThan(source, group.best)) group.best = source;
    }
    return [...groups.values()];
}

/** How many documents these passages came from. */
export function documentCountOf(sources: ReadonlyArray<CitedSource | null | undefined>): number {
    return groupByDocument(sources).length;
}
