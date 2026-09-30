/**
 * The meeting library's filters, sort and multi-select, ported from agent-hub
 * MeetingLibrary.jsx (the `filtered` memo and the report selection) and
 * LibraryFilters.jsx (which tag chips show). Pure, so the Meeting Notes tab only
 * holds state.
 */

import type { TranscriptionSummary } from './types';

/** `GET /api/transcriptions/tags`: one chip, counting NOTES (not occurrences). */
export interface TagCount {
    tag: string;
    count: number;
}

/** `POST /api/transcriptions/report`. */
export interface MeetingReport {
    report: string;
    /** False when the transcripts were too long together and summaries were used. */
    usedTranscripts: boolean;
    /** How many notes were shortened to fit. */
    truncatedNotes: number;
}

export type LibrarySort = 'recent' | 'oldest' | 'longest' | 'title';
export type LibraryOwner = 'all' | 'mine' | 'shared';

export const LIBRARY_SORTS: readonly LibrarySort[] = ['recent', 'oldest', 'longest', 'title'];

export interface LibraryFilter {
    query: string;
    sort: LibrarySort;
    owner: LibraryOwner;
    tag: string | null;
}

export const DEFAULT_FILTER: LibraryFilter = { query: '', sort: 'recent', owner: 'all', tag: null };

/** The server's own cap (REPORT_MAX_NOTES in routes/transcriptions/report.js). */
export const REPORT_MAX_NOTES = 10;

/** The web's VISIBLE_TAGS: the rest fold behind "+N tags". */
export const VISIBLE_TAGS = 5;

const time = (iso: string | null) => (iso ? new Date(iso).getTime() || 0 : 0);

function matchesQuery(m: TranscriptionSummary, needle: string): boolean {
    const haystacks = [m.title, m.fileName ?? '', ...(m.tags ?? []), m.transcriptSnippet ?? ''];
    return haystacks.some((text) => text.toLowerCase().includes(needle));
}

function matchesOwner(m: TranscriptionSummary, owner: LibraryOwner, userId: string | null): boolean {
    if (owner === 'mine') return m.isOwner !== false && m.ownerId === userId;
    if (owner === 'shared') return Boolean(m.ownerId) && m.ownerId !== userId;
    return true;
}

const COMPARE: Record<LibrarySort, (a: TranscriptionSummary, b: TranscriptionSummary) => number> = {
    recent: (a, b) => time(b.createdAt) - time(a.createdAt),
    oldest: (a, b) => time(a.createdAt) - time(b.createdAt),
    longest: (a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0),
    title: (a, b) => a.title.localeCompare(b.title),
};

/** The rows the library shows, in order. */
export function filterMeetings(
    meetings: readonly TranscriptionSummary[],
    filter: LibraryFilter,
    userId: string | null,
): TranscriptionSummary[] {
    const needle = filter.query.trim().toLowerCase();
    return meetings
        .filter((m) => !needle || matchesQuery(m, needle))
        .filter((m) => matchesOwner(m, filter.owner, userId))
        .filter((m) => !filter.tag || (m.tags ?? []).includes(filter.tag))
        .sort(COMPARE[filter.sort]);
}

/** Is any filter narrowing the list? Decides "no match" over "no meetings yet". */
export function isFiltering(filter: LibraryFilter): boolean {
    return Boolean(filter.query.trim()) || filter.owner !== 'all' || filter.tag !== null;
}

/**
 * The tag chips to show: count DESC then name, folded to VISIBLE_TAGS unless
 * expanded — with the active tag always pinned in, because a filter you
 * cannot see is a filter you cannot switch off.
 */
export function visibleTags(
    tags: readonly TagCount[],
    active: string | null,
    expanded: boolean,
): { shown: TagCount[]; hidden: number } {
    const ordered = tags
        .filter((r) => r.tag)
        .slice()
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    if (expanded || ordered.length <= VISIBLE_TAGS) return { shown: ordered, hidden: 0 };
    const head = ordered.slice(0, VISIBLE_TAGS);
    if (active && !head.some((r) => r.tag === active)) {
        const pinned = ordered.find((r) => r.tag === active);
        if (pinned) head.splice(VISIBLE_TAGS - 1, 1, pinned);
    }
    return { shown: head, hidden: ordered.length - head.length };
}

/** A note still transcribing or failed has nothing to report on. */
export function isReportable(m: TranscriptionSummary): boolean {
    return m.status === 'completed';
}

/** Toggle one note in the report selection, never past the server's cap. */
export function toggleSelected(selected: readonly string[], m: TranscriptionSummary): string[] {
    if (!isReportable(m)) return [...selected];
    if (selected.includes(m.id)) return selected.filter((id) => id !== m.id);
    return selected.length < REPORT_MAX_NOTES ? [...selected, m.id] : [...selected];
}
