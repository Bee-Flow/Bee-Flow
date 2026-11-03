/**
 * A conversation's Outlook categories, from ALL of its stored messages.
 *
 * The sync only holds part of a thread now and then (an expansion cap, an
 * unreadable thread), and a slice of the messages is a slice of the categories.
 * So the conversation's `labels` is not computed from the run but from the app's
 * own message table, after the messages of the run are written: the union of
 * their categories, each once (first spelling, in message-id order so the text
 * is stable between runs). A category taken off a message in Outlook leaves the
 * conversation too.
 *
 * Which conversations: every one this run wrote, plus up to BACKFILL_PER_RUN
 * whose `labels` is still NULL. NULL means "never computed" (a column the sync
 * just added, rows written before it existed); a computed row holds a string,
 * '' when no message carries a category, so it is not picked up again. That is
 * the one-off backfill, spread over runs, without a flag to keep.
 *
 * A row is written only when its labels change, through the same record-write
 * choke point the sync uses. Outlook, thread mode only; Gmail labels are ids.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { key: string; type?: string; sourcePath?: string };
type Table = { id?: string; key: string; fields?: Field[] };
type Model = { tables?: Table[] };
type Connector = {
    kind?: string; provider?: string; groupIntoThreads?: boolean;
    sync?: { tableId?: string; children?: Array<{ tableId?: string; level?: number; relationField?: string }> } | null;
};
type App = { id: string; userId: string };
type Row = Record<string, unknown>;
type Log = { warn: (m: string) => void };

export type ThreadLabelDeps = {
    query: (ownerId: string, appId: string, sql: string, params: unknown[]) => Promise<{ rows?: Row[] }>;
    writeRecord: (app: App, model: Model, table: Table, values: Record<string, unknown>, opts: { viewer: { id: string; role: string }; recordId: string }) => Promise<unknown>;
};

const log = nodeRequire('../telemetry/log') as Log;

export const BACKFILL_PER_RUN = 500;
const CHUNK = 200;

const labelsColumn = (table: Table | undefined) => (table?.fields || []).find((f) => f?.key === 'labels' || f?.sourcePath === 'labels')?.key ?? null;
const qi = (name: string) => `"${String(name).replace(/"/g, '""')}"`;

/** The tables and columns involved, or null when this connector has no conversation labels to keep. */
export function threadLabelTargets(model: Model, connector: Connector) {
    const sync = connector?.sync;
    if (connector?.kind !== 'mailbox' || connector.provider !== 'outlook' || !connector.groupIntoThreads || !sync?.tableId) return null;
    const child = (sync.children || []).find((c) => c?.level === 1 && c.tableId && c.relationField);
    const byId = new Map((model?.tables || []).map((t) => [t.id, t]));
    const threads = byId.get(sync.tableId);
    const messages = child ? byId.get(child.tableId) : undefined;
    const threadLabels = labelsColumn(threads);
    const messageLabels = labelsColumn(messages);
    if (!threads || !messages || !child?.relationField || !threadLabels || !messageLabels) return null;
    return { threads, messages, relation: child.relationField, threadLabels, messageLabels };
}

/** Union of comma-separated label lists, each label once (case-insensitive), first spelling and order kept. */
export function unionLabels(lists: unknown[]): string {
    const seen = new Map<string, string>();
    for (const list of lists) {
        for (const part of String(list ?? '').split(',')) {
            const name = part.trim();
            if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
        }
    }
    return [...seen.values()].join(',');
}

const chunks = <T,>(list: T[]): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
    return out;
};

/**
 * Recompute `labels` for the conversations this run wrote (`touchedIds`, record ids, nulls
 * skipped) and up to BACKFILL_PER_RUN never computed ones. Returns how many rows changed.
 * Never throws: the sync it follows has already succeeded.
 */
export async function refreshThreadLabels(
    app: App, model: Model, connector: Connector, touchedIds: Array<string | null | undefined>, deps: ThreadLabelDeps,
): Promise<number> {
    const t = threadLabelTargets(model, connector);
    if (!t) return 0;
    try {
        const thr = qi(t.threads.key);
        const backfill = await deps.query(app.userId, app.id,
            `SELECT "id" FROM ${thr} WHERE ${qi(t.threadLabels)} IS NULL LIMIT ${BACKFILL_PER_RUN}`, []);
        const ids = [...new Set([
            ...touchedIds.filter((id): id is string => typeof id === 'string' && id !== ''),
            ...(backfill.rows || []).map((r) => String(r.id)),
        ])];
        if (!ids.length) return 0;

        const current = new Map<string, unknown>();
        const lists = new Map<string, unknown[]>();
        for (const part of chunks(ids)) {
            const marks = part.map(() => '?').join(', ');
            const cur = await deps.query(app.userId, app.id,
                `SELECT "id", ${qi(t.threadLabels)} AS labels FROM ${thr} WHERE "id" IN (${marks})`, part);
            for (const r of cur.rows || []) current.set(String(r.id), r.labels);
            const msgs = await deps.query(app.userId, app.id,
                `SELECT ${qi(t.relation)} AS parent, ${qi(t.messageLabels)} AS labels FROM ${qi(t.messages.key)} `
                + `WHERE ${qi(t.relation)} IN (${marks}) ORDER BY "id"`, part);
            for (const r of msgs.rows || []) {
                const key = String(r.parent);
                const list = lists.get(key) || [];
                list.push(r.labels);
                lists.set(key, list);
            }
        }

        let changed = 0;
        const viewer = { id: app.userId, role: 'owner' };
        for (const id of ids) {
            if (!current.has(id)) continue;        // removed meanwhile
            const next = unionLabels(lists.get(id) || []);
            if (current.get(id) === next) continue;
            await deps.writeRecord(app, model, t.threads, { [t.threadLabels]: next }, { viewer, recordId: id });
            changed += 1;
        }
        return changed;
    } catch (e) {
        log.warn(`[MailboxLabels] conversation labels for app ${app.id}: ${(e as Error)?.message}`);
        return 0;
    }
}
