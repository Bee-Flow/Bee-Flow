/**
 * A reply sent from an app, recorded before the mailbox could say its id.
 *
 * send_email records every sent reply straight away (emailStep.js
 * recordOutboundReply), so the conversation shows it without waiting for a
 * sync. Gmail answers the send with the message's real id, and the next sync
 * upserts onto that row. Outlook's `/reply` answers 202 with no body, so the
 * row is keyed `local-…` instead, and the copy in Sent Items, which thread
 * mode reads back (fetch.js listThreadMessages reads every folder), arrives
 * with its real Graph id: same reply, second row.
 *
 * Before the sync writes, each outbound message in the batch claims the
 * recorded row it stands for: same conversation, outbound, keyed `local-`,
 * sent within REPLY_MATCH_MS, same subject once Re:/RE: is stripped (Outlook
 * writes its own prefix), nearest in time first, one row per message. The
 * claimed row takes the real id, and the upsert then updates it in place. When
 * the real id is already stored as well, the recorded row is the duplicate
 * and is removed.
 *
 * A draft saved by send_email (mode "draft", direction 'draft') is claimed the
 * same way once someone sends it from the mailbox, without the time window:
 * the copy may come hours later. Until then the draft row stays a draft.
 *
 * Best effort by design: the caller logs a failure and syncs on, which at
 * worst leaves the duplicate this exists to prevent.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Field = { key: string; sourcePath?: string; type?: string };
type Table = { id?: string; key: string; fields: Field[] };
type AccessFilter = { where: string; params: unknown[] };
type Compiled = { sql: string; params: unknown[] };
type QueryResult = { rows?: Row[] } | Row[] | null | undefined;

type QueryCompiler = {
    compileRecordList: (t: Table, opts: object, f: AccessFilter) => Compiled;
    compileKeyIndex: (t: Table, keyField: string, keys: string[], f: AccessFilter) => Compiled;
    compileUpdate: (t: Table, id: string, values: Row, f: AccessFilter) => Compiled;
    compileDelete: (t: Table, id: string, f: AccessFilter) => Compiled;
};
const queryCompiler = nodeRequire('./queryCompiler') as QueryCompiler;
const { normalizeSubject } = nodeRequire('../services/email/parse') as { normalizeSubject: (s: unknown) => string };

export type ReplyDeps = {
    query: (ownerId: string, appId: string, sql: string, params: unknown[]) => Promise<QueryResult>;
    exec: (ownerId: string, appId: string, sql: string, params: unknown[]) => Promise<unknown>;
};

type App = { id: string; userId: string };
type SyncChild = { level?: number; tableId?: string };
type Connector = { groupIntoThreads?: boolean; sync?: { tableId?: string; children?: SyncChild[] } };
type Model = { tables?: Table[] };
type Grain = { level?: unknown; rows?: unknown[] };

/** How far apart the recorded reply and the provider's copy may be stamped. */
export const REPLY_MATCH_MS = 15 * 60 * 1000;
const LOCAL_PREFIX = 'local-';
const OWNER_FILTER: AccessFilter = Object.freeze({ where: '1=1', params: [] }) as AccessFilter;
// The compiler's own ceiling for an `in` list.
const MAX_KEYS = 200;

const COLUMNS = ['provider_message_id', 'thread_key', 'direction', 'received_at', 'subject'] as const;
type Column = typeof COLUMNS[number];

/** The table the connector writes its MESSAGES to: grain 1 in thread mode, grain 0 otherwise. */
function messageTarget(model: Model, connector: Connector): { table: Table; level: number } | null {
    const level = connector.groupIntoThreads ? 1 : 0;
    const tableId = level === 0
        ? connector.sync?.tableId
        : (connector.sync?.children || []).find((c) => c && c.level === 1)?.tableId;
    const table = (model.tables || []).find((t) => t && t.id === tableId);
    return table ? { table, level } : null;
}

/** Column key per message field, the way connectorSync maps them; null when one is missing. */
function columnKeys(table: Table): Record<Column, string> | null {
    const out = {} as Record<Column, string>;
    for (const name of COLUMNS) {
        const field = table.fields.find((f) => f.sourcePath === name) || table.fields.find((f) => f.key === name);
        if (!field) return null;
        out[name] = field.key;
    }
    return out;
}

const rowsOf = (result: QueryResult): Row[] => (Array.isArray(result) ? result : (result?.rows || []));
const stamp = (v: unknown): number => (v ? new Date(v as string).getTime() : NaN);
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

type Candidate = { id: string; thread: string; at: number; subject: string };

/** Outbound messages in the batch that carry a real provider id. */
function syncedOutbound(rows: unknown[]): Candidate[] {
    const out: Candidate[] = [];
    for (const raw of rows) {
        const r = (raw || {}) as Row;
        const id = text(r.provider_message_id);
        if (r.direction !== 'outbound' || !id || id.startsWith(LOCAL_PREFIX) || !r.thread_key) continue;
        out.push({ id, thread: text(r.thread_key), at: stamp(r.received_at), subject: normalizeSubject(r.subject) });
    }
    return out;
}

/**
 * The unclaimed candidate nearest in time to this recorded row, or null. A
 * recorded reply was sent at once, so its copy is stamped within
 * REPLY_MATCH_MS either way; a draft is sent whenever someone gets to it, so
 * any copy stamped after it (less the same slack for clocks) will do.
 */
function nearest(local: Row, cols: Record<Column, string>, candidates: Candidate[], claimed: Set<string>, draft = false): Candidate | null {
    const at = stamp(local[cols.received_at]);
    const subject = normalizeSubject(local[cols.subject]);
    let best: Candidate | null = null;
    for (const c of candidates) {
        if (claimed.has(c.id) || c.thread !== text(local[cols.thread_key])) continue;
        if (subject && c.subject && subject !== c.subject) continue;
        const gap = Math.abs(c.at - at);
        if (draft ? !(c.at >= at - REPLY_MATCH_MS) : !(gap <= REPLY_MATCH_MS)) continue;
        if (!best || gap < Math.abs(best.at - at)) best = c;
    }
    return best;
}

/**
 * Let the provider's copies of sent replies take over the rows send_email
 * recorded for them. Returns how many rows took a real id and how many
 * duplicates were removed.
 */
export async function adoptRecordedReplies(
    app: App, model: Model, connector: Connector, grains: Grain[] | null, deps: ReplyDeps,
): Promise<{ adopted: number; removed: number }> {
    const done = { adopted: 0, removed: 0 };
    const target = messageTarget(model, connector);
    if (!target || !grains) return done;
    const cols = columnKeys(target.table);
    const candidates = syncedOutbound(grains[target.level]?.rows || []).slice(0, MAX_KEYS);
    if (!cols || !candidates.length) return done;

    const { table } = target;
    const threads = [...new Set(candidates.map((c) => c.thread))];
    const list = queryCompiler.compileRecordList(table, {
        filters: [
            { field: cols.provider_message_id, op: 'startsWith', value: LOCAL_PREFIX },
            { field: cols.direction, op: 'eq', value: 'outbound' },
            { field: cols.thread_key, op: 'in', value: threads },
        ],
        sort: [{ field: cols.received_at, dir: 'asc' }],
        limit: MAX_KEYS,
    }, OWNER_FILTER);
    const locals = rowsOf(await deps.query(app.userId, app.id, list.sql, list.params));
    // A draft send_email saved (mode "draft") has the provider's DRAFT id; once
    // someone sends it from the mailbox, the copy comes back under a new id.
    const draftList = queryCompiler.compileRecordList(table, {
        filters: [
            { field: cols.direction, op: 'eq', value: 'draft' },
            { field: cols.thread_key, op: 'in', value: threads },
        ],
        sort: [{ field: cols.received_at, dir: 'asc' }],
        limit: MAX_KEYS,
    }, OWNER_FILTER);
    const drafts = rowsOf(await deps.query(app.userId, app.id, draftList.sql, draftList.params));
    if (!locals.length && !drafts.length) return done;

    const index = queryCompiler.compileKeyIndex(table, cols.provider_message_id, candidates.map((c) => c.id), OWNER_FILTER);
    const stored = new Set(rowsOf(await deps.query(app.userId, app.id, index.sql, index.params)).map((r) => text(r.k)));

    const claimed = new Set<string>();
    const rows: Array<[Row, boolean]> = [...locals.map((r): [Row, boolean] => [r, false]), ...drafts.map((r): [Row, boolean] => [r, true])];
    for (const [local, draft] of rows) {
        const match = nearest(local, cols, candidates, claimed, draft);
        // The same id is the same row: the upsert updates it in place.
        if (!match || match.id === text(local[cols.provider_message_id])) continue;
        claimed.add(match.id);
        const recordId = text(local.id);
        const write = stored.has(match.id)
            ? queryCompiler.compileDelete(table, recordId, OWNER_FILTER)
            : queryCompiler.compileUpdate(table, recordId, { [cols.provider_message_id]: match.id }, OWNER_FILTER);
        await deps.exec(app.userId, app.id, write.sql, write.params);
        if (stored.has(match.id)) done.removed += 1;
        else done.adopted += 1;
    }
    return done;
}
