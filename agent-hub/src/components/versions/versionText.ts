// The words and groupings of the version history, shared by the list, the
// compare view and the panel. Pure: every sentence is a `versions.*` key with
// its English fallback, and the caller passes `t`.

import type { VersionContributor, VersionMeta, VersionStats } from '../../api/queries/versions';
import { VersionRequestError } from '../../api/queries/versions';

export type TFn = (key: string, fallback: string, params?: Record<string, unknown>) => string;

/** Display names of the people who may appear in a history, keyed by user id. */
export type PeopleNames = Record<string, { name?: string; email?: string } | undefined>;

/** What a version's source means to a reader. */
export function sourceLabel(t: TFn, source: string): string {
    switch (source) {
        case 'created': return t('versions.source.created', 'Created');
        case 'checkpoint': return t('versions.source.checkpoint', 'Edits saved');
        case 'autosave': return t('versions.source.autosave', 'Autosaved');
        case 'named': return t('versions.source.named', 'Named version');
        case 'ai': return t('versions.source.ai', 'AI edit');
        case 'restore': return t('versions.source.restore', 'Restored an earlier version');
        case 'pre_restore': return t('versions.source.pre_restore', 'Before a restore');
        case 'conflict': return t('versions.source.conflict', 'Saved during a conflict');
        case 'import': return t('versions.source.import', 'Imported');
        default: return t('versions.source.legacy', 'Earlier state');
    }
}

/** Small enough to fold away: a handful of words in one block. */
export function isMinorStats(stats: VersionStats | null | undefined): boolean {
    if (!stats) return false;
    return stats.wordsAdded + stats.wordsRemoved < 5 && stats.blocksChanged <= 1;
}

/** "+12 words, −3 words", or null when nothing is known. */
export function statsText(t: TFn, stats: VersionStats | null | undefined): string | null {
    if (!stats) return null;
    const parts: string[] = [];
    if (stats.wordsAdded) parts.push(t('versions.stats.added', '+{n} words', { n: stats.wordsAdded }));
    if (stats.wordsRemoved) parts.push(t('versions.stats.removed', '−{n} words', { n: stats.wordsRemoved }));
    if (!parts.length && stats.blocksChanged) return t('versions.stats.format_only', 'Formatting or layout');
    return parts.length ? parts.join(', ') : null;
}

/** A contributor's name as the reader should see it. */
export function contributorName(t: TFn, c: VersionContributor, people: PeopleNames, currentUserId?: string | null): string {
    if (c.kind === 'ai' && !c.userId) return t('versions.who.ai', 'AI');
    if (c.userId && c.userId === currentUserId) return t('versions.who.you', 'You');
    const p = c.userId ? people[c.userId] : undefined;
    return p?.name || p?.email || t('versions.who.former', 'Former member');
}

export interface ContributorLine {
    /** The people, with the AI folded into whom it worked for. */
    people: Array<{ userId: string; name: string; withAi: boolean }>;
    /** The AI took part (for somebody or on its own). */
    ai: boolean;
    /** The AI worked with nobody in particular. */
    aiAlone: boolean;
}

/** The contributors of a version as a line of people plus an AI flag. */
export function contributorLine(t: TFn, list: VersionContributor[], people: PeopleNames, currentUserId?: string | null): ContributorLine {
    const byUser = new Map<string, { userId: string; name: string; withAi: boolean }>();
    let ai = false;
    let aiAlone = false;
    for (const c of list) {
        if (c.kind === 'ai') {
            ai = true;
            if (!c.userId) { aiAlone = true; continue; }
        }
        if (!c.userId) continue;
        const entry = byUser.get(c.userId) || { userId: c.userId, name: contributorName(t, { userId: c.userId, kind: 'user' }, people, currentUserId), withAi: false };
        if (c.kind === 'ai') entry.withAi = true;
        byUser.set(c.userId, entry);
    }
    // "You" first: "You and Anna" reads as a sentence, "Anna and You" does not.
    const ordered = [...byUser.values()].sort((a, b) => Number(b.userId === currentUserId) - Number(a.userId === currentUserId));
    return { people: ordered, ai, aiAlone };
}

/** "Anna and Bob", "Anna, with AI", "AI". */
export function contributorSummary(t: TFn, line: ContributorLine): string {
    const names = line.people.map((p) => p.name);
    let who: string;
    if (names.length === 0) who = line.ai ? t('versions.who.ai', 'AI') : t('versions.who.unknown', 'Unknown');
    else if (names.length === 1) who = names[0];
    else if (names.length === 2) who = t('versions.who.two', '{a} and {b}', { a: names[0], b: names[1] });
    else who = t('versions.who.many', '{a} and {n} others', { a: names[0], n: names.length - 1 });
    if (names.length && line.people.some((p) => p.withAi)) return t('versions.who.with_ai', '{who}, with AI', { who });
    if (names.length && line.aiAlone) return t('versions.who.and_ai', '{who} and AI', { who });
    return who;
}

// ── Day groups and folding ──────────────────────────────────────────────

export interface DayGroup<T> {
    key: string;
    label: string;
    items: T[];
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** Versions (newest first) grouped per local day: Today, Yesterday, then dates. */
export function groupByDay(t: TFn, versions: VersionMeta[], now: Date = new Date(), locale?: string): Array<DayGroup<VersionMeta>> {
    const today = dayKey(now);
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    const yesterday = dayKey(yest);
    const groups: Array<DayGroup<VersionMeta>> = [];
    for (const v of versions) {
        const at = new Date(v.createdAt);
        const valid = !Number.isNaN(at.getTime());
        const key = valid ? dayKey(at) : 'unknown';
        let label: string;
        if (!valid) label = t('versions.day.unknown', 'Date unknown');
        else if (key === today) label = t('versions.day.today', 'Today');
        else if (key === yesterday) label = t('versions.day.yesterday', 'Yesterday');
        else label = at.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
        const last = groups[groups.length - 1];
        if (last && last.key === key) last.items.push(v);
        else groups.push({ key, label, items: [v] });
    }
    return groups;
}

export type ListEntry =
    | { kind: 'version'; version: VersionMeta }
    | { kind: 'fold'; id: string; versions: VersionMeta[] };

const AUTOMATIC = new Set(['autosave', 'checkpoint']);
/** A run of at least this many small automatic versions folds into one row. */
const FOLD_MIN = 3;

/** Is this a small automatic version, the kind a reader skims past? */
export function isQuietVersion(v: VersionMeta): boolean {
    return AUTOMATIC.has(String(v.source)) && !v.name && !v.pinned && isMinorStats(v.stats);
}

/**
 * The rows of one day: runs of FOLD_MIN or more small automatic versions fold
 * into one "N small edits" row; everything else is its own row. A version in
 * `keepOpen` (the one selected) never folds away.
 */
export function foldQuiet(versions: VersionMeta[], keepOpen: ReadonlySet<string> = new Set()): ListEntry[] {
    const out: ListEntry[] = [];
    let run: VersionMeta[] = [];
    const flush = () => {
        if (run.length >= FOLD_MIN) out.push({ kind: 'fold', id: `fold-${run[0].id}`, versions: run });
        else for (const v of run) out.push({ kind: 'version', version: v });
        run = [];
    };
    for (const v of versions) {
        if (isQuietVersion(v) && !keepOpen.has(v.id)) {
            run.push(v);
        } else {
            flush();
            out.push({ kind: 'version', version: v });
        }
    }
    flush();
    return out;
}

// ── Errors ──────────────────────────────────────────────────────────────

/** A refused versions request in the reader's words. */
export function versionErrorText(t: TFn, error: unknown, fallback?: string): string {
    const status = error instanceof VersionRequestError ? error.status : null;
    if (status === 409) return t('versions.error.conflict', 'This changed while you were looking at it. Refresh the history and try again.');
    if (status === 403) return t('versions.error.forbidden', 'You can look at the history, but only editors can change it.');
    if (status === 404) return t('versions.error.not_found', 'This version is no longer available.');
    if (status === 503) return t('versions.error.unavailable', 'The history is not available right now. Try again in a moment.');
    if (fallback) return fallback;
    return error instanceof Error && error.message ? error.message : t('versions.error.generic', 'Something went wrong. Try again.');
}
