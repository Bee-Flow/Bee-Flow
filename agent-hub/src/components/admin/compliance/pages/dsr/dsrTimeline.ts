/**
 * The DSR drawer's timeline: one server row read tolerantly, and the facts we
 * always have when the server has no timeline yet.
 *
 * Server rows are `{ kind, at, by, text }` (routes/dsr.js appendTimeline):
 * `text` is null for most kinds, so the line is the translated kind
 * (`compliance.dsr_timeline_<kind>`, or the row's own `label_key`). `by` is a
 * user id, or null for what the system did; it is shown by name from the org
 * roster, or as "a handler" when the roster does not know it, never as the
 * raw id.
 */
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { channelOf, completedAtOf, dueAtOf, isOverdue, receivedAtOf, stateOf } from './dsrArticles';
import { channelLabel, formatDateTime } from './DsrTable';

export interface TimelineRow {
    at: number | null;
    text: string;
    tone: 'error' | null;
}

export interface OrgUser {
    id: string | number;
    displayName?: string | null;
    email?: string | null;
}

export type OrgUsers = readonly OrgUser[] | null | undefined;

type Row = Record<string, unknown>;

function toMs(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(String(v)).getTime();
    return Number.isFinite(n) ? n : null;
}

const present = (v: unknown): boolean => v !== null && v !== undefined && v !== '';

/**
 * Who acted, as a name: the name the server resolved, else the roster's,
 * else "a handler". null when nobody did (a system row carries `by: null`).
 */
export function actorName(t: TranslateFn, id: unknown, orgUsers: OrgUsers, name?: unknown): string | null {
    if (present(name)) return String(name);
    if (!present(id)) return null;
    const user = Array.isArray(orgUsers) ? orgUsers.find((u) => String(u?.id) === String(id)) : undefined;
    const shown = user?.displayName || user?.email;
    return shown ? String(shown) : t('compliance.dsr_handler_unknown', 'a handler');
}

const AT_KEYS = ['at', 'occurred_at', 'created_at', 'ts', 'timestamp'] as const;
const TEXT_KEYS = ['label', 'text', 'message', 'description'] as const;

/** The first present value among `keys` on a row, else null. */
function firstOf(r: Row, keys: readonly string[]): unknown {
    for (const k of keys) if (present(r[k])) return r[k];
    return null;
}

/** The row's own words, else its kind through `compliance.dsr_timeline_<kind>` (or the row's own label_key). */
function textOf(t: TranslateFn, r: Row, kind: unknown): string {
    const own = firstOf(r, TEXT_KEYS);
    if (present(own)) return String(own);
    if (!present(kind)) return '';
    const key = typeof r.label_key === 'string' && r.label_key ? r.label_key : `compliance.dsr_timeline_${String(kind)}`;
    return t(key, String(kind));
}

function isErrorRow(r: Row, kind: unknown): boolean {
    return r.tone === 'error' || r.severity === 'error' || /overdue|expired|verstreken|failed/i.test(String(kind ?? ''));
}

/** Tolerant read of one server timeline row → { at, text, tone }. */
export function normaliseTimelineRow(t: TranslateFn, row: unknown, orgUsers: OrgUsers = null): TimelineRow | null {
    if (!row || typeof row !== 'object') return null;
    const r = row as Row;
    const kind = firstOf(r, ['event', 'kind']);
    const text = textOf(t, r, kind);
    const actor = actorName(t, firstOf(r, ['actor', 'by']), orgUsers, r.actor_name);
    return {
        at: toMs(firstOf(r, AT_KEYS)),
        text: actor ? t('compliance.dsr_tl_by', '{text} · by {actor}', { text, actor }) : text,
        tone: isErrorRow(r, kind) ? 'error' : null,
    };
}

/** "Started by {name}" (or "Started") when the request has a start. */
function startedRow(t: TranslateFn, request: Row, orgUsers: OrgUsers): TimelineRow | null {
    const at = toMs(request?.started_at);
    if (at === null) return null;
    const by = actorName(t, request?.started_by, orgUsers, request?.started_by_name);
    return { at, text: by ? t('compliance.dsr_tl_started_by', 'Started by {name}', { name: by }) : t('compliance.dsr_tl_started', 'Started'), tone: null };
}

/** The facts we always have when the server has no timeline yet. */
export function fallbackTimeline(t: TranslateFn, request: Row, now: number = Date.now(), orgUsers: OrgUsers = null): TimelineRow[] {
    const rows: TimelineRow[] = [];
    const received = receivedAtOf(request);
    if (received !== null) rows.push({ at: received, text: t('compliance.dsr_tl_received', 'Received via {channel} · clock started', { channel: channelLabel(t, channelOf(request)) }), tone: null });
    const started = startedRow(t, request, orgUsers);
    if (started) rows.push(started);
    const extended = toMs(request?.extended_until);
    if (extended !== null) rows.push({ at: toMs(request?.extended_at) ?? started?.at ?? received, text: t('compliance.dsr_tl_extended', 'Extended to {date}', { date: formatDateTime(extended) }), tone: null });
    if (isOverdue(request, now)) rows.push({ at: dueAtOf(request), text: t('compliance.dsr_tl_overdue', 'Deadline passed'), tone: 'error' });
    const completed = completedAtOf(request);
    if (completed !== null) {
        rows.push({ at: completed, text: stateOf(request) === 'rejected' ? t('compliance.dsr_tl_rejected', 'Rejected') : t('compliance.dsr_tl_fulfilled', 'Fulfilled · data subject e-mailed'), tone: null });
    }
    return rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
