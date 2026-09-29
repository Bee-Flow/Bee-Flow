/**
 * The two ledgers as ONE stream of "messages & calls", newest first.
 *
 *   guardrail_events         a row each time the shield acted on a message
 *   integration_activity_log a row for every call to an outside service
 *
 * The pane used to show them as two tables behind a switch. The design merges
 * them into one log, and the outcome filter takes over the switch's job
 * ("only what left with a tool", "only what the shield stopped").
 *
 * Built on the normalisers in shieldRows.js, so the map, the destination
 * list and the log keep reading the same location fields; this module only
 * adds what the merged view needs on top:
 *
 *  - an id prefixed 'g:' / 'e:'. Both tables number their rows with their own
 *    SERIAL, so shield event 7 and call 7 would share a React key and an
 *    "open row" otherwise.
 *  - the outcome (outcomes.ts), the region of a call, the local day and the
 *    clock time, and what kind of thing the entry was.
 *
 * Configuration-audit rows (nc_scope admin/user actions) share the shield's
 * table but are not about a message; they are left out here, as they are in
 * every figure.
 */

import { isMarker } from './activityLabels';
import { NOTE_VIOLATION_TYPES, carriesKinds, isAuditRow, outcomeOfAction, outcomeOfCall, type Outcome } from './outcomes';
import { clockTime, dayKey } from './shieldDates';
import { isCapped } from './shieldFilters';
import { normaliseEgressRows, normaliseGuardRows } from './shieldRows';
import { regionOf, type Region } from '../shieldPalette';

/** What an entry was: a message to an AI model, a tool call, or a web search. */
export type EntryType = 'model' | 'tool' | 'web_search';

type RawRow = Record<string, unknown>;

export interface StreamRow {
    /** 'g:<id>' for a shield event, 'e:<id>' for a call. */
    id: string;
    source: 'guard' | 'egress';
    ts: string;
    /** Local calendar day, `YYYY-MM-DD`; null when the timestamp is unreadable. */
    day: string | null;
    /** `HH:MM` on the local clock. */
    time: string;
    person: string;
    personLabel: string;
    place: string;
    /** Canonical category ids (and audit markers) found in it: what the chips show and the kind filter matches. */
    kinds: string[];
    /**
     * The kinds of personal data actually FOUND: `kinds` without the audit
     * markers, and empty for a row whose categories column cannot name a find
     * (a failed check, a note). What "personal data found" counts.
     */
    found: string[];
    outcome: Outcome;
    /** The stored word: a shield event's action_taken, a call's status. */
    action: string;
    entry: EntryType;
    /** The host a call went to; null for a shield event. */
    dest: string | null;
    /** The AI model a shield event was about; null for a call. */
    model: string | null;
    /** Where a call went; null for a shield event (the ledger has no place for it). */
    region: Region | null;
    // A call's location, as shieldRows.js reads it (absent on shield events).
    state?: string;
    basis?: string | null;
    city?: string | null;
    countryCode?: string | null;
    countryName?: string | null;
    country?: string;
    network?: string | null;
    edgePop?: string | null;
    peerIp?: string | null;
    asOrg?: string | null;
    operator?: string;
    lat?: number | null;
    lon?: number | null;
    raw: RawRow;
}

/** Shield actions that are about a tool call or a web search rather than a message to a model. */
const TOOL_ACTIONS = new Set(['tool_blocked', 'tool_result_redacted']);
const SEARCH_ACTIONS = new Set(['search_blocked']);

function guardEntry(action: string): EntryType {
    if (TOOL_ACTIONS.has(action)) return 'tool';
    if (SEARCH_ACTIONS.has(action)) return 'web_search';
    return 'model';
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const tsValue = (ts: string): number => {
    const n = new Date(ts).getTime();
    return Number.isFinite(n) ? n : -Infinity;
};

interface Options {
    placeLabel?: (row: RawRow) => string;
}

/** What the normalisers in shieldRows.js return, as far as this module reads it. */
type Normalised = Record<string, unknown> & { id: string; ts: string; kinds: string[]; action?: string; state?: string; raw: RawRow };

/** The markers leave; a row whose type cannot carry kinds found none. */
function foundIn(kinds: string[], violationType = ''): string[] {
    return carriesKinds(violationType) ? kinds.filter(k => !isMarker(k)) : [];
}

/** Both ledgers → one stream, newest first. */
export function toStreamRows(guardRows: RawRow[] | null | undefined, egressRows: RawRow[] | null | undefined, { placeLabel = row => text(row.source) }: Options = {}): StreamRow[] {
    const guard = (normaliseGuardRows((guardRows || []).filter(r => !isAuditRow(r)), { placeLabel }) as Normalised[])
        .map(r => ({
            ...r,
            id: `g:${r.id}`,
            source: 'guard',
            // A note's column ("12 hidden chars") is not a kind to filter on.
            kinds: NOTE_VIOLATION_TYPES.has(text(r.raw.violation_type)) ? [] : r.kinds,
            found: foundIn(r.kinds, text(r.raw.violation_type)),
            outcome: outcomeOfAction(r.action, text(r.raw.violation_type)),
            region: null,
            day: dayKey(r.ts),
            time: clockTime(r.ts),
            entry: guardEntry(text(r.action)),
            dest: null,
            model: text(r.raw.model) || null,
        }) as unknown as StreamRow);
    const egress = (normaliseEgressRows(egressRows || [], { placeLabel }) as Normalised[])
        .map((r) => {
            const found = foundIn(r.kinds);
            return {
                ...r,
                id: `e:${r.id}`,
                source: 'egress',
                action: text(r.raw.status),
                found,
                outcome: outcomeOfCall(text(r.raw.status), found.length, text(r.raw.pii_scan_level) || null),
                region: regionOf(r.state),
                day: dayKey(r.ts),
                time: clockTime(r.ts),
                entry: r.raw.integration_type === 'web_search' ? 'web_search' : 'tool',
                model: null,
            } as unknown as StreamRow;
        });
    return [...guard, ...egress].sort((a, b) => (tsValue(b.ts) - tsValue(a.ts)) || a.id.localeCompare(b.id));
}

export interface Coverage {
    /** Either fetch hit its ceiling, so the rows are not the whole window. */
    capped: boolean;
    /**
     * When capped: the oldest moment BOTH samples still cover. Before it, one
     * ledger may be missing entirely (200 shield events can span three days
     * while 200 calls span thirty), so a per-day picture older than this
     * would compare a full day with an empty one. Null when not capped.
     */
    since: string | null;
}

function oldest(rows: RawRow[]): string | null {
    let best: string | null = null;
    for (const row of rows) {
        const ts = text(row.timestamp);
        if (ts && tsValue(ts) > -Infinity && (best === null || tsValue(ts) < tsValue(best))) best = ts;
    }
    return best;
}

interface CoverageInput {
    guardRows: RawRow[];
    egressRows: RawRow[];
    /** The aggregate totals for the window: shield events (audit rows included) and calls. */
    guardTotal: number;
    egressTotal: number;
    limit: number;
}

/**
 * How much of the window the fetched rows cover.
 *
 * `guardTotal` counts the configuration-audit rows too, which the stream
 * leaves out. That can only make a sample read as capped when it is not —
 * the safe direction for a caveat.
 */
export function sampleCoverage({ guardRows, egressRows, guardTotal, egressTotal, limit }: CoverageInput): Coverage {
    const samples = [
        { rows: guardRows, capped: isCapped({ fetched: guardRows.length, total: guardTotal, limit }) },
        { rows: egressRows, capped: isCapped({ fetched: egressRows.length, total: egressTotal, limit }) },
    ].filter(s => s.capped);
    if (samples.length === 0) return { capped: false, since: null };
    const starts = samples.map(s => oldest(s.rows)).filter((ts): ts is string => !!ts);
    const since = starts.length ? starts.reduce((a, b) => (tsValue(b) > tsValue(a) ? b : a)) : null;
    return { capped: true, since };
}

/** Group rows (already in display order) by day, for the log's day headers. */
export function groupByDay<T extends { day: string | null }>(rows: T[]): Array<{ day: string | null; rows: T[] }> {
    const out: Array<{ day: string | null; rows: T[] }> = [];
    for (const row of rows) {
        const last = out[out.length - 1];
        if (last && last.day === row.day) last.rows.push(row);
        else out.push({ day: row.day, rows: [row] });
    }
    return out;
}
