/**
 * stores/studioAppData/recordEvents.mts: the outbox of record triggers (studio_app_record_events,
 * DDL in ./schema.js). One row is one DELIVERY: a changed record for one armed trigger. The rules
 * are in appStudio/triggers/ (recordTriggerRule.mts, recordOutbox.mts, recordDrain.mts); this file
 * only reads and writes.
 *
 *   armedRecordTriggers  the armed rows of kind `record` (what the write path keeps in memory)
 *   add                  write deliveries; one that would put an app over its pending limit is
 *                        not written and comes back as dropped
 *   listReady            per trigger the OLDEST pending delivery, for triggers that are armed and
 *                        whose last run is not still going: one at a time, in the order written
 *   claim                pending -> claimed as a compare-and-set: of two instances one gets it
 *   release              claimed -> pending again (the trigger's own claim was lost)
 *   finish               claimed -> fired (with the run) or skipped (with the code); a skipped
 *                        row drops its row values at once
 *   noteSkip             write a skipped delivery on its trigger row, so the panel shows it
 *   countWriterFires     the runs one writer started in an app since a moment (the burst limit)
 *   forRun               the delivery that started a run (the run's `trigger` scope, the run log)
 *   prune                expire pending rows past their time, delete finished rows past the
 *                        retention (never one whose run is still going or on hold) and rows
 *                        whose trigger is gone
 *
 * A row that stays `claimed` (the process died between the claim and the start) is never handed
 * out again: a delivery starts at most one run. It is deleted with the finished rows.
 * Times are the caller's clock in epoch ms, as in ./triggers.mts.
 */

import { createRequire } from 'node:module';

import type { Queryable, RunDb } from './actionRuns.mts';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type QueryResult = Awaited<ReturnType<Queryable['query']>>;

export type RecordDelivery = {
    seq: number; appId: string; triggerId: string; tableId: string; event: string; rowId: string;
    before: Row | null; after: Row | null; writerKind: string; writerKey: string | null;
    depth: number; causeTriggerId: string | null; state: string; outcomeCode: string | null; runId: string | null;
    createdAt: string | null;
};

export type NewDelivery = Pick<RecordDelivery, 'appId' | 'triggerId' | 'tableId' | 'event' | 'rowId' | 'before' | 'after' | 'writerKind' | 'writerKey' | 'depth' | 'causeTriggerId'>;

export type ArmedRecordTrigger = { appId: string; triggerId: string; config: Row };

const changed = (r: QueryResult): number => r.rowCount ?? r.affectedRows ?? 0;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asObj = (v: unknown): Row | null => {
    let j: unknown = v ?? null;
    if (typeof v === 'string') { try { j = JSON.parse(v); } catch { j = null; } }
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Row : null;
};
const TS = (param: string): string => `to_timestamp(${param}::double precision / 1000)`;

function toDelivery(row: Row): RecordDelivery {
    return {
        seq: Number(row.seq), appId: String(row.app_id), triggerId: String(row.trigger_id), tableId: String(row.table_id),
        event: String(row.event), rowId: String(row.row_id), before: asObj(row.row_before), after: asObj(row.row_after),
        writerKind: String(row.writer_kind), writerKey: text(row.writer_key), depth: Number(row.depth ?? 0),
        causeTriggerId: text(row.cause_trigger_id), state: String(row.state), outcomeCode: text(row.outcome_code), runId: text(row.run_id),
        createdAt: iso(row.created_at),
    };
}

export function makeRecordEventStore(db: RunDb, { ready = async () => {} }: { ready?: () => Promise<unknown> } = {}) {
    async function armedRecordTriggers(): Promise<ArmedRecordTrigger[]> {
        await ready();
        const { rows } = await db.query(`SELECT app_id, trigger_id, config FROM studio_app_triggers WHERE kind = 'record' AND state = 'armed'`);
        return rows.map((r) => ({ appId: String(r.app_id), triggerId: String(r.trigger_id), config: asObj(r.config) ?? {} }));
    }

    /**
     * Write the deliveries. `maxPending` (0 = unlimited) is the most pending rows one app may
     * hold: the check and the insert are one statement, so two writers cannot both slip under it
     * by more than their own rows. Returns the trigger ids whose delivery was dropped.
     */
    async function add(list: NewDelivery[], nowMs: number, maxPending: number): Promise<{ written: number; dropped: string[] }> {
        await ready();
        let written = 0;
        const dropped: string[] = [];
        for (const d of list) {
            const res = await db.query(
                `INSERT INTO studio_app_record_events
                    (app_id, trigger_id, table_id, event, row_id, row_before, row_after, writer_kind, writer_key, depth, cause_trigger_id, created_at)
                 SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, ${TS('$12')}
                  WHERE $13::int = 0 OR (SELECT COUNT(*) FROM studio_app_record_events WHERE app_id = $1 AND state = 'pending') < $13::int`,
                [d.appId, d.triggerId, d.tableId, d.event, d.rowId, d.before ? JSON.stringify(d.before) : null, d.after ? JSON.stringify(d.after) : null,
                    d.writerKind, d.writerKey, d.depth, d.causeTriggerId, nowMs, Math.max(0, Math.floor(maxPending))],
            );
            if (changed(res) > 0) written += 1; else dropped.push(d.triggerId);
        }
        return { written, dropped };
    }

    async function listReady(limit: number): Promise<RecordDelivery[]> {
        await ready();
        const { rows } = await db.query(
            `SELECT * FROM (
                SELECT DISTINCT ON (e.app_id, e.trigger_id) e.*
                  FROM studio_app_record_events e
                  JOIN studio_app_triggers t ON t.app_id = e.app_id AND t.trigger_id = e.trigger_id
                 WHERE e.state = 'pending' AND t.state = 'armed' AND t.kind = 'record' AND t.last_status IS DISTINCT FROM 'running'
                 ORDER BY e.app_id, e.trigger_id, e.seq
             ) first ORDER BY seq ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''}`,
        );
        return rows.map(toDelivery);
    }

    async function claim(seq: number, nowMs: number): Promise<RecordDelivery | null> {
        await ready();
        const { rows } = await db.query(
            `UPDATE studio_app_record_events SET state = 'claimed', claimed_at = ${TS('$2')} WHERE seq = $1 AND state = 'pending' RETURNING *`,
            [seq, nowMs],
        );
        return rows[0] ? toDelivery(rows[0]) : null;
    }

    async function release(seq: number): Promise<void> {
        await ready();
        await db.query(`UPDATE studio_app_record_events SET state = 'pending', claimed_at = NULL WHERE seq = $1 AND state = 'claimed'`, [seq]);
    }

    /** `fired`: the run is the one the trigger row now names. `skipped`: the row values go at once. */
    async function finish(d: RecordDelivery, nowMs: number, outcome: { state: 'fired' } | { state: 'skipped'; code: string }): Promise<void> {
        await ready();
        if (outcome.state === 'fired') {
            await db.query(
                `UPDATE studio_app_record_events
                    SET state = 'fired', done_at = ${TS('$2')},
                        run_id = (SELECT last_run_id FROM studio_app_triggers WHERE app_id = $3 AND trigger_id = $4)
                  WHERE seq = $1 AND state = 'claimed'`,
                [d.seq, nowMs, d.appId, d.triggerId],
            );
            return;
        }
        await db.query(
            `UPDATE studio_app_record_events
                SET state = 'skipped', outcome_code = $3, done_at = ${TS('$2')}, row_before = NULL, row_after = NULL
              WHERE seq = $1 AND state IN ('claimed', 'pending')`,
            [d.seq, nowMs, outcome.code.slice(0, 60)],
        );
    }

    /** A delivery that started no run, shown on its trigger. A run that is going keeps its own status. */
    async function noteSkip(appId: string, triggerId: string, status: string, message: string): Promise<void> {
        await ready();
        await db.query(
            `UPDATE studio_app_triggers SET last_status = $3, last_error = $4, updated_at = NOW()
              WHERE app_id = $1 AND trigger_id = $2 AND last_status IS DISTINCT FROM 'running'`,
            [appId, triggerId, status, message.slice(0, 500)],
        );
    }

    async function countWriterFires(appId: string, writerKey: string, sinceMs: number): Promise<number> {
        await ready();
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS n FROM studio_app_record_events
              WHERE app_id = $1 AND writer_key = $2 AND state = 'fired' AND done_at >= ${TS('$3')}`,
            [appId, writerKey, sinceMs],
        );
        return Number(rows[0]?.n ?? 0);
    }

    async function forRun(runId: string): Promise<RecordDelivery | null> {
        await ready();
        const { rows } = await db.query(`SELECT * FROM studio_app_record_events WHERE run_id = $1 ORDER BY seq LIMIT 1`, [runId]);
        return rows[0] ? toDelivery(rows[0]) : null;
    }

    /**
     * `pendingBeforeMs` (null: never): pending rows written before it expire, and come back so the
     * caller can show it on their triggers. `doneBeforeMs`: finished and stuck rows older than it go,
     * except a fired row whose run is still going or on hold (it is that run's `trigger` scope).
     */
    async function prune(p: { nowMs: number; pendingBeforeMs: number | null; doneBeforeMs: number }): Promise<{ expired: Array<{ appId: string; triggerId: string }>; deleted: number }> {
        await ready();
        let expired: Array<{ appId: string; triggerId: string }> = [];
        if (p.pendingBeforeMs !== null) {
            const { rows } = await db.query(
                `UPDATE studio_app_record_events
                    SET state = 'skipped', outcome_code = 'expired', done_at = ${TS('$1')}, row_before = NULL, row_after = NULL
                  WHERE state = 'pending' AND created_at < ${TS('$2')}
              RETURNING app_id, trigger_id`,
                [p.nowMs, p.pendingBeforeMs],
            );
            const seen = new Set<string>();
            expired = rows.map((r) => ({ appId: String(r.app_id), triggerId: String(r.trigger_id) }))
                .filter((r) => { const k = `${r.appId}\n${r.triggerId}`; if (seen.has(k)) return false; seen.add(k); return true; });
        }
        const gone = await db.query(
            `DELETE FROM studio_app_record_events e
              WHERE (e.state IN ('fired', 'skipped') AND e.done_at < ${TS('$1')}
                     AND NOT EXISTS (SELECT 1 FROM studio_app_action_runs r WHERE r.id = e.run_id AND r.status IN ('running', 'paused')))
                 OR (e.state = 'claimed' AND e.claimed_at < ${TS('$1')})
                 OR NOT EXISTS (SELECT 1 FROM studio_app_triggers t WHERE t.app_id = e.app_id AND t.trigger_id = e.trigger_id)`,
            [p.doneBeforeMs],
        );
        return { expired, deleted: changed(gone) };
    }

    return { armedRecordTriggers, add, listReady, claim, release, finish, noteSkip, countWriterFires, forRun, prune };
}

export type RecordEventStore = ReturnType<typeof makeRecordEventStore>;

let singleton: RecordEventStore | null = null;

/** The store over the app's database, created on first use (awaits the data store's init). */
export function recordEventStore(): RecordEventStore {
    if (!singleton) {
        const dbMod = nodeRequire('../../db') as { run: (sql: string, params?: unknown[]) => Promise<QueryResult>; withTransaction: <T>(fn: (c: Queryable) => Promise<T>) => Promise<T> };
        singleton = makeRecordEventStore(
            { query: (sql, params) => dbMod.run(sql, params), tx: (fn) => dbMod.withTransaction(fn) },
            { ready: () => (nodeRequire('./schema') as { initDB: () => Promise<unknown> }).initDB() },
        );
    }
    return singleton;
}
