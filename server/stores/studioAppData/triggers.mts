/**
 * stores/studioAppData/triggers.mts: the armed triggers of published apps (studio_app_triggers,
 * DDL in ./schema.js). The rules are in appStudio/triggers/; this file only reads and writes.
 *
 *   syncApp          make the app's rows equal to the triggers its published definition arms:
 *                    add, update, remove. One transaction over the app's rows, so two instances
 *                    that publish at once leave one consistent set, and a second call with the
 *                    same input changes nothing
 *   disarmApp        remove every row of an app (unpublish)
 *   remove           remove one row (a fire found it no longer matches what is published)
 *   listForApp       the rows of an app, for the panel
 *   listDue          armed rows whose time passed and whose last run is not still going
 *   claimFire        the fire as a compare-and-set on fire_seq: of two instances one gets the row
 *   recordStart      the run a fire started
 *   recordSkip       a fire that started no run, and why
 *   listUnsettled    rows whose last run was still going when last looked at
 *   settle           how that run ended: the status, the failures in a row, a back-off or a pause
 *   setPaused        pause or re-arm one row (the owner in the panel)
 *   countRunningRuns / countRunsInWindow   the trigger runs of an app, for the limits
 *
 * Times go in and out as epoch milliseconds / ISO text; "now" is always the caller's clock, so a
 * test with a fake clock and the job on a real one read the same code.
 */

import { createRequire } from 'node:module';

import type { Queryable, RunDb } from './actionRuns.mts';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type QueryResult = Awaited<ReturnType<Queryable['query']>>;

export type TriggerState = 'armed' | 'paused';

export type TriggerRow = {
    appId: string; triggerId: string; ownerUserId: string; kind: string; actionId: string; config: Row; fingerprint: string;
    state: TriggerState; pausedCode: string | null; pausedReason: string | null;
    nextFireAt: string | null; lastFiredAt: string | null; lastRunId: string | null; lastStatus: string | null; lastError: string | null;
    consecutiveFailures: number; fireSeq: number; armedAt: string | null;
};

/** A trigger the published definition arms: what its row must hold. */
export type DesiredTrigger = { triggerId: string; kind: string; actionId: string; config: Row; fingerprint: string; nextFireAt: number | null };

export type SyncResult = { armed: number; updated: number; kept: number; removed: number };

export type Settle = {
    status: string; error: string | null; failures: number;
    /** Do not fire before this moment (a back-off), in epoch ms. */
    notBefore?: number | null;
    /** Pause the trigger with this code and sentence. */
    pause?: { code: string; reason: string } | null;
};

const changed = (r: QueryResult): number => r.rowCount ?? r.affectedRows ?? 0;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asObj = (v: unknown): Row => {
    let j: unknown = v ?? null;
    if (typeof v === 'string') { try { j = JSON.parse(v); } catch { j = null; } }
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Row : {};
};
/** Epoch ms as a timestamp parameter (NULL stays NULL). */
const TS = (param: string): string => `to_timestamp(${param}::double precision / 1000)`;

function toTrigger(row: Row): TriggerRow {
    return {
        appId: String(row.app_id), triggerId: String(row.trigger_id), ownerUserId: String(row.owner_user_id), kind: String(row.kind),
        actionId: String(row.action_id), config: asObj(row.config), fingerprint: String(row.fingerprint),
        state: row.state === 'paused' ? 'paused' : 'armed', pausedCode: text(row.paused_code), pausedReason: text(row.paused_reason),
        nextFireAt: iso(row.next_fire_at), lastFiredAt: iso(row.last_fired_at), lastRunId: text(row.last_run_id),
        lastStatus: text(row.last_status), lastError: text(row.last_error),
        consecutiveFailures: Number(row.consecutive_failures ?? 0), fireSeq: Number(row.fire_seq ?? 0), armedAt: iso(row.armed_at),
    };
}

/** A pause the owner asked for stays through a publish that did not change the trigger; every other pause is lifted by it. */
export const USER_PAUSE = 'user';

export function makeTriggerStore(db: RunDb, { ready = async () => {} }: { ready?: () => Promise<unknown> } = {}) {
    async function syncApp(appId: string, ownerUserId: string, desired: DesiredTrigger[]): Promise<SyncResult> {
        await ready();
        return db.tx(async (client) => {
            const { rows } = await client.query('SELECT * FROM studio_app_triggers WHERE app_id = $1 FOR UPDATE', [appId]);
            const have = new Map(rows.map((r) => [String(r.trigger_id), toTrigger(r)]));
            const out: SyncResult = { armed: 0, updated: 0, kept: 0, removed: 0 };
            for (const want of desired) {
                const row = have.get(want.triggerId);
                have.delete(want.triggerId);
                const same = !!row && row.fingerprint === want.fingerprint && row.kind === want.kind && row.ownerUserId === ownerUserId;
                if (same && (row.state === 'armed' || row.pausedCode === USER_PAUSE)) {
                    out.kept += 1;
                    continue;
                }
                // New, changed, or paused by something a publish answers: armed afresh.
                await client.query(
                    `INSERT INTO studio_app_triggers (app_id, trigger_id, owner_user_id, kind, action_id, config, fingerprint, state, next_fire_at)
                     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'armed', ${TS('$8')})
                     ON CONFLICT (app_id, trigger_id) DO UPDATE
                        SET owner_user_id = EXCLUDED.owner_user_id, kind = EXCLUDED.kind, action_id = EXCLUDED.action_id, config = EXCLUDED.config,
                            fingerprint = EXCLUDED.fingerprint, state = 'armed', paused_code = NULL, paused_reason = NULL,
                            next_fire_at = EXCLUDED.next_fire_at, consecutive_failures = 0, armed_at = NOW(), updated_at = NOW()`,
                    [appId, want.triggerId, ownerUserId, want.kind, want.actionId, JSON.stringify(want.config), want.fingerprint, want.nextFireAt],
                );
                if (row) out.updated += 1; else out.armed += 1;
            }
            const gone = [...have.keys()];
            if (gone.length) {
                out.removed = changed(await client.query('DELETE FROM studio_app_triggers WHERE app_id = $1 AND trigger_id = ANY($2::text[])', [appId, gone]));
            }
            return out;
        });
    }

    async function disarmApp(appId: string): Promise<number> {
        await ready();
        return changed(await db.query('DELETE FROM studio_app_triggers WHERE app_id = $1', [appId]));
    }

    async function remove(appId: string, triggerId: string): Promise<boolean> {
        await ready();
        return changed(await db.query('DELETE FROM studio_app_triggers WHERE app_id = $1 AND trigger_id = $2', [appId, triggerId])) > 0;
    }

    async function listForApp(appId: string): Promise<TriggerRow[]> {
        await ready();
        const { rows } = await db.query('SELECT * FROM studio_app_triggers WHERE app_id = $1 ORDER BY trigger_id', [appId]);
        return rows.map(toTrigger);
    }

    /** Armed rows that are due at `nowMs`, oldest first. A row whose last run is still going waits for it. `limit` 0: all. */
    async function listDue(nowMs: number, limit: number): Promise<TriggerRow[]> {
        await ready();
        const { rows } = await db.query(
            `SELECT * FROM studio_app_triggers
              WHERE state = 'armed' AND next_fire_at IS NOT NULL AND next_fire_at <= ${TS('$1')}
                AND last_status IS DISTINCT FROM 'running'
              ORDER BY next_fire_at, app_id, trigger_id ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''}`,
            [nowMs],
        );
        return rows.map(toTrigger);
    }

    /**
     * Take the fire: only the caller whose `fireSeq` is still the row's gets it, and the row moves
     * to its next time in the same statement, so a second instance (or a second pass) finds
     * nothing due. Null: someone else fired it, or it is no longer armed.
     */
    async function claimFire(row: TriggerRow, at: { firedAt: number; nextFireAt: number | null }): Promise<TriggerRow | null> {
        await ready();
        const { rows } = await db.query(
            `UPDATE studio_app_triggers
                SET fire_seq = fire_seq + 1, last_fired_at = ${TS('$4')}, next_fire_at = ${TS('$5')}, updated_at = NOW()
              WHERE app_id = $1 AND trigger_id = $2 AND fire_seq = $3 AND state = 'armed' AND last_status IS DISTINCT FROM 'running'
          RETURNING *`,
            [row.appId, row.triggerId, row.fireSeq, at.firedAt, at.nextFireAt],
        );
        return rows[0] ? toTrigger(rows[0]) : null;
    }

    async function recordStart(row: TriggerRow, runId: string): Promise<void> {
        await ready();
        await db.query(
            `UPDATE studio_app_triggers SET last_run_id = $4, last_status = 'running', last_error = NULL, updated_at = NOW()
              WHERE app_id = $1 AND trigger_id = $2 AND fire_seq = $3`,
            [row.appId, row.triggerId, row.fireSeq, runId],
        );
    }

    /** A fire that started no run: `status` says what kind (skipped, refused), `error` why. Failures in a row are untouched. */
    async function recordSkip(row: TriggerRow, status: string, error: string): Promise<void> {
        await ready();
        await db.query(
            `UPDATE studio_app_triggers SET last_run_id = NULL, last_status = $4, last_error = $5, updated_at = NOW()
              WHERE app_id = $1 AND trigger_id = $2 AND fire_seq = $3`,
            [row.appId, row.triggerId, row.fireSeq, status, error.slice(0, 500)],
        );
    }

    async function listUnsettled(limit: number): Promise<TriggerRow[]> {
        await ready();
        const { rows } = await db.query(
            `SELECT * FROM studio_app_triggers WHERE last_status = 'running' AND last_run_id IS NOT NULL
              ORDER BY last_fired_at ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''}`,
        );
        return rows.map(toTrigger);
    }

    /** Write how the run of the last fire ended. Only the instance that still sees that run as going changes the row. */
    async function settle(row: TriggerRow, s: Settle): Promise<boolean> {
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_triggers
                SET last_status = $4, last_error = $5, consecutive_failures = $6,
                    next_fire_at = CASE WHEN $7::double precision IS NULL OR next_fire_at IS NULL THEN next_fire_at ELSE GREATEST(next_fire_at, ${TS('$7')}) END,
                    state = CASE WHEN $8::text IS NULL THEN state ELSE 'paused' END,
                    paused_code = CASE WHEN $8::text IS NULL THEN paused_code ELSE $8 END,
                    paused_reason = CASE WHEN $8::text IS NULL THEN paused_reason ELSE $9 END,
                    updated_at = NOW()
              WHERE app_id = $1 AND trigger_id = $2 AND last_run_id = $3 AND last_status = 'running'`,
            [row.appId, row.triggerId, row.lastRunId, s.status, s.error ? s.error.slice(0, 500) : null, s.failures,
                s.notBefore ?? null, s.pause?.code ?? null, s.pause?.reason ?? null],
        )) > 0;
    }

    /**
     * Pause one row, or arm it again. Re-arming forgets the failures and takes `nextFireAt` as the
     * new time. Null when the app has no such row (the trigger is not armed).
     */
    async function setPaused(appId: string, triggerId: string, p: { paused: true; code: string; reason: string } | { paused: false; nextFireAt: number | null }): Promise<TriggerRow | null> {
        await ready();
        const { rows } = p.paused
            ? await db.query(
                `UPDATE studio_app_triggers SET state = 'paused', paused_code = $3, paused_reason = $4, updated_at = NOW()
                  WHERE app_id = $1 AND trigger_id = $2 RETURNING *`,
                [appId, triggerId, p.code, p.reason],
            )
            : await db.query(
                `UPDATE studio_app_triggers
                    SET state = 'armed', paused_code = NULL, paused_reason = NULL, consecutive_failures = 0, next_fire_at = ${TS('$3')}, updated_at = NOW()
                  WHERE app_id = $1 AND trigger_id = $2 RETURNING *`,
                [appId, triggerId, p.nextFireAt],
            );
        return rows[0] ? toTrigger(rows[0]) : null;
    }

    /** Trigger runs of the app that are going now (a row that stopped beating does not count). */
    async function countRunningRuns(appId: string, staleMs: number): Promise<number> {
        await ready();
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS n FROM studio_app_action_runs
              WHERE app_id = $1 AND origin = 'trigger' AND status = 'running'
                AND last_activity_at >= NOW() - make_interval(secs => $2::double precision / 1000)`,
            [appId, staleMs],
        );
        return Number(rows[0]?.n ?? 0);
    }

    /** Trigger runs of the app started in the last `windowMs` (the database's clock: the run rows carry it). */
    async function countRunsInWindow(appId: string, windowMs: number): Promise<number> {
        await ready();
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS n FROM studio_app_action_runs
              WHERE app_id = $1 AND origin = 'trigger' AND started_at >= NOW() - make_interval(secs => $2::double precision / 1000)`,
            [appId, windowMs],
        );
        return Number(rows[0]?.n ?? 0);
    }

    return { syncApp, disarmApp, remove, listForApp, listDue, claimFire, recordStart, recordSkip, listUnsettled, settle, setPaused, countRunningRuns, countRunsInWindow };
}

export type TriggerStore = ReturnType<typeof makeTriggerStore>;

let singleton: TriggerStore | null = null;

/** The store over the app's database, created on first use (awaits the data store's init). */
export function triggerStore(): TriggerStore {
    if (!singleton) {
        const dbMod = nodeRequire('../../db') as { run: (sql: string, params?: unknown[]) => Promise<QueryResult>; withTransaction: <T>(fn: (c: Queryable) => Promise<T>) => Promise<T> };
        singleton = makeTriggerStore(
            { query: (sql, params) => dbMod.run(sql, params), tx: (fn) => dbMod.withTransaction(fn) },
            { ready: () => (nodeRequire('./schema') as { initDB: () => Promise<unknown> }).initDB() },
        );
    }
    return singleton;
}
