/**
 * Which DOCUMENT a cited passage came from — the port of
 * agent-hub/src/components/chat/MessageItem/citationGroups.ts (pinned by
 * citationGroups.lockstep.test.ts, and through answerChips.lockstep.test.ts).
 *
 * A message's `sources` hold one entry per PASSAGE, and several passages of
 * one document are normal. Rendered as-is, a handful of meeting notes read as
 * ten identical chips, as if the same notes had been fetched over and over
 * (BFSF-352). This changes what is SHOWN, never what was retrieved.
 *
 * As on the web, it is the one grouping the chip row, the sources in "How I
 * got this answer" and that line's document count share, so the three never
 * disagree about how many documents an answer used.
 *
 * The key, most specific first:
 *   1. a live table row (`datatableId` + `rowId`) is its own source;
 *   2. the document, `documentId`;
 *   3. the title plus the day the thing happened, so two meetings that share a
 *      title stay two;
 *   4. the title alone.
 * A passage with none of these lands in one "unknown" group.
 */

import type { KbSource } from './types';

/** One document and the passages of it this answer cited. */
export interface CitationGroup<T extends KbSource> {
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

function documentKeyOf(source: KbSource | null | undefined): string {
    if (!source || typeof source !== 'object') return 'unknown';
    const tableId = text(source.datatableId);
    const rowId = text(source.rowId);
    if (tableId && rowId) return `row:${tableId}:${rowId}`;
    const documentId = text(source.documentId);
    if (documentId) return `doc:${documentId}`;
    const title = text(source.title);
    if (!title) return 'unknown';
    const when = text(source.occurredAt);
    return when ? `title:${title}\u0000${when}` : `title:${title}`;
}

function scoreOf(source: KbSource): number {
    return typeof source.score === 'number' && Number.isFinite(source.score) ? source.score : -Infinity;
}

/** The passage itself came with the answer (`content`), as citationIsOpenable reads it. */
function openable(source: KbSource): boolean {
    return Boolean(source.openable && text(source.snippet));
}

/**
 * Is `candidate` a better passage to open than `current`? One that can be
 * opened always beats one that cannot; after that the higher score wins, and
 * a tie keeps the earlier, higher-ranked one.
 */
function betterThan(candidate: KbSource, current: KbSource): boolean {
    const a = openable(candidate);
    const b = openable(current);
    if (a !== b) return a;
    return scoreOf(candidate) > scoreOf(current);
}

/** Group passages by document, in the order each document first appears. */
export function groupByDocument<T extends KbSource>(sources: readonly (T | null | undefined)[]): CitationGroup<T>[] {
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
export function documentCountOf(sources: readonly (KbSource | null | undefined)[]): number {
    return groupByDocument(sources).length;
}
