/**
 * screen.mts: one name screened against the candidate rows the store found for it.
 *
 *   screenCandidates({ name: 'Qusay Hussein', birthDate: '1966' }, rows, { minScore: 0.85 })
 *   -> [{ score: 0.93, nameScore: 0.9, listId: 'eu_fsf', entityId: '20', matchedName: 'Qusay Saddam Hussein Al-Tikriti', ... }]
 *
 * Per entity the best of its names counts. A birth date and a country move that score a little:
 *
 *   - birth date: the same full date +0.08, the same year (or one year off when the list only
 *     knows a year) +0.04; known on both sides and every listed year more than one year away
 *     -0.15, because a different birth year is the strongest sign of a namesake;
 *   - country: one of the listed countries (citizenship, nationality, address) +0.03, known on
 *     both sides and none in common -0.05.
 *
 * The result is capped to 0..1, filtered at `minScore` and sorted. It never says "this is the
 * person": a candidate is something a person checks, and every one carries the list's own
 * reference so they can.
 *
 * Pure: the rows arrive as data (stores/sanctionsStore.mts candidatesForKeys).
 */

import { birthDateKey, countryCode, foldText, nameTokens } from './normalize.mts';
import { nameSimilarity } from './match.mts';

export interface ScreenQuery {
    name: string;
    birthDate?: string | null;
    country?: string | null;
}

/** One stored name with the entity it belongs to, as candidatesForKeys returns it. */
export interface CandidateRow {
    listId: string;
    entityId: string;
    kind: string;
    primaryName: string;
    name: string;
    birthDates: string[];
    countries: string[];
    programmes: string[];
    reference: string | null;
    url: string | null;
}

export interface Candidate {
    score: number;
    nameScore: number;
    listId: string;
    entityId: string;
    kind: string;
    primaryName: string;
    matchedName: string;
    birthDates: string[];
    countries: string[];
    programmes: string[];
    reference: string | null;
    url: string | null;
    reasons: string[];
}

export interface ScreenOptions {
    minScore?: number;
    maxResults?: number;
    /** Only these list ids (empty or absent: every list). */
    lists?: string[] | null;
}

export const DEFAULT_MIN_SCORE = 0.85;
export const DEFAULT_MAX_RESULTS = 10;
export const MAX_RESULTS = 50;

const round = (n: number): number => Math.round(n * 1000) / 1000;

function yearOf(key: string): number | null {
    const y = Number(key.slice(0, 4));
    return Number.isInteger(y) ? y : null;
}

/** The birth-date adjustment and its reason. */
export function birthDateAdjustment(queryDate: string | null, listed: string[]): { delta: number; reason: string | null } {
    if (!queryDate || !listed.length) return { delta: 0, reason: null };
    if (queryDate.length === 10 && listed.includes(queryDate)) return { delta: 0.08, reason: 'same birth date' };
    const qYear = yearOf(queryDate);
    if (qYear === null) return { delta: 0, reason: null };
    let near = false;
    for (const d of listed) {
        const y = yearOf(d);
        if (y === null) continue;
        if (y === qYear) return { delta: 0.04, reason: 'same birth year' };
        // A list that only knows a year (or the query does) may be a year off.
        if (Math.abs(y - qYear) <= 1 && (d.length === 4 || queryDate.length === 4)) near = true;
    }
    if (near) return { delta: 0.04, reason: 'birth year within one year' };
    return { delta: -0.15, reason: 'different birth year' };
}

/** The country adjustment and its reason. */
export function countryAdjustment(queryCountry: string | null, listed: string[]): { delta: number; reason: string | null } {
    if (!queryCountry || !listed.length) return { delta: 0, reason: null };
    const code = countryCode(queryCountry);
    const folded = foldText(queryCountry);
    if (listed.some((c) => c === code || c === folded)) return { delta: 0.03, reason: 'same country' };
    return { delta: -0.05, reason: 'different country' };
}

function scoreRow(queryTokens: string[], q: ScreenQuery, row: CandidateRow): Candidate {
    const nameScore = nameSimilarity(queryTokens, nameTokens(row.name), { candidateIsEntity: row.kind !== 'person' && row.kind !== 'unknown' });
    const reasons: string[] = [];
    let score = nameScore;
    const dob = birthDateAdjustment(birthDateKey(q.birthDate ?? null), row.birthDates);
    const ctry = countryAdjustment(typeof q.country === 'string' && q.country.trim() ? q.country : null, row.countries);
    for (const adj of [dob, ctry]) {
        score += adj.delta;
        if (adj.reason) reasons.push(adj.reason);
    }
    return {
        score: round(Math.max(0, Math.min(1, score))), nameScore: round(nameScore),
        listId: row.listId, entityId: row.entityId, kind: row.kind, primaryName: row.primaryName, matchedName: row.name,
        birthDates: row.birthDates, countries: row.countries, programmes: row.programmes,
        reference: row.reference, url: row.url, reasons,
    };
}

/** Clamp the caller's options to what the screening allows. */
export function screenOptions(o: ScreenOptions = {}): { minScore: number; maxResults: number; lists: string[] | null } {
    const min = typeof o.minScore === 'number' && Number.isFinite(o.minScore) ? Math.min(1, Math.max(0.5, o.minScore)) : DEFAULT_MIN_SCORE;
    const max = typeof o.maxResults === 'number' && Number.isInteger(o.maxResults) ? Math.min(MAX_RESULTS, Math.max(1, o.maxResults)) : DEFAULT_MAX_RESULTS;
    const lists = Array.isArray(o.lists) && o.lists.length ? o.lists.filter((l) => typeof l === 'string') : null;
    return { minScore: min, maxResults: max, lists };
}

/** The candidates worth a person's look, best first, one per listed entity. */
export function screenCandidates(q: ScreenQuery, rows: CandidateRow[], options: ScreenOptions = {}): Candidate[] {
    const { minScore, maxResults, lists } = screenOptions(options);
    const queryTokens = nameTokens(q.name);
    if (!queryTokens.length) return [];
    const best = new Map<string, Candidate>();
    for (const row of rows) {
        if (lists && !lists.includes(row.listId)) continue;
        const c = scoreRow(queryTokens, q, row);
        const key = `${row.listId}\u0000${row.entityId}`;
        const prev = best.get(key);
        if (!prev || c.score > prev.score) best.set(key, c);
    }
    return [...best.values()]
        .filter((c) => c.score >= minScore)
        .sort((a, b) => b.score - a.score || a.listId.localeCompare(b.listId))
        .slice(0, maxResults);
}
