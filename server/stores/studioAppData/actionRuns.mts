/**
 * stores/studioAppData/actionRuns.mts: the action-run rows of an app (studio_app_action_runs,
 * DDL in ./schema.js). A background job is one row: inserted `running` (taking its lockKey),
 * progressed, heart-beaten, finished once. Not in the studioAppDataStore facade: the runner and
 * the jobs reach it through `actionRunStore()`.
 *
 *   insertRunningRun     start a row; a running row with the same app + lock_key refuses it
 *                        (a holder that stopped beating is reclaimed to `interrupted` first)
 *   countRunning         running rows of an app (optionally one viewer's), for the caps
 *   updateProgress       the progress JSON (and last_activity_at)
 *   heartbeat            last_activity_at of the rows this process runs
 *   finishRun            the end state; only a running row changes (never resurrects)
 *   getRun / listRunsForViewer / isLockHeld
 *   markStaleInterrupted rows nobody beats any more (a crashed replica) → interrupted
 *   markInterrupted      this process's rows at shutdown → interrupted
 *   pruneRuns            payloads nulled after the TTL, rows deleted after the retention; a
 *                        pause that outlived the retention, or whose starter is gone, is ended
 *
 * A run on hold (pause, resume claim, wake, cancel): the queries of ./pausedRuns.mts, part of
 * this store.
 *
 * Every read is keyed by the app id the caller has ALREADY authorised. Plain TypeScript; the
 * database arrives as `db` ({ query, tx }), the init as `ready`.
 */

import { createRequire } from 'node:module';

import { makePausedRunQueries } from './pausedRuns.mts';
import type { EndedWait } from './pausedRuns.mts';

const nodeRequire = createRequire(import.meta.url);

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number | null; affectedRows?: number };
export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<QueryResult>;
}
export interface RunDb extends Queryable {
    tx<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
}

export type RunStatus = 'running' | 'paused' | 'success' | 'error' | 'interrupted' | 'cancelled' | 'refused';

export type ActionRunRow = {
    id: string; appId: string; ownerUserId: string; actionId: string; origin: string; draft: boolean;
    definitionVersion: number | null; dryRun: boolean; viewerUserId: string | null; status: RunStatus;
    error: string | null; errorCode: string | null; errorStep: Record<string, unknown> | null;
    lockKey: string | null; progress: Record<string, unknown>; result: unknown; vars: Record<string, unknown> | null;
    effects: unknown[] | null; instanceId: string | null; stepCount: number;
    startedAt: string | null; lastActivityAt: string | null; endedAt: string | null; durationMs: number | null;
    /** A run on hold: when it was paused, when the wake job continues it, what it waits for. Never the state itself. */
    pausedAt: string | null; wakeAt: string | null; waitKind: string | null; waitRef: string | null;
    resumeSeq: number; hasResumeToken: boolean; cancelRequested: boolean;
    /** The trigger of the app's definition that started the run (origin `trigger`), else null. */
    triggerId: string | null;
};

export type InsertRun = {
    id: string; appId: string; ownerUserId: string; viewerUserId: string | null; actionId: string; origin: string;
    draft: boolean; definitionVersion: number | null; dryRun: boolean; lockKey: string | null; instanceId: string | null;
    staleMs: number; triggerId?: string | null;
};

export type FinishRun = {
    status: Exclude<RunStatus, 'running' | 'paused'>; result?: unknown; vars?: Record<string, unknown> | null; effects?: unknown[] | null;
    error?: string | null; errorCode?: string | null; errorStep?: Record<string, unknown> | null; durationMs?: number | null;
    stepCount?: number; truncated?: boolean; endedBy?: string | null;
};

const changed = (r: QueryResult): number => r.rowCount ?? r.affectedRows ?? 0;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const json = (v: unknown): unknown => {
    if (typeof v !== 'string') return v ?? null;
    try { return JSON.parse(v); } catch { return null; }
};
const asObj = (v: unknown): Record<string, unknown> | null => {
    const j = json(v);
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null;
};
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const toJson = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

function toRun(row: Record<string, unknown>): ActionRunRow {
    const effects = json(row.effects);
    return {
        id: String(row.id), appId: String(row.app_id), ownerUserId: String(row.owner_user_id), actionId: String(row.action_id),
        origin: String(row.origin), draft: row.draft === true, definitionVersion: num(row.definition_version), dryRun: row.dry_run === true,
        viewerUserId: text(row.viewer_user_id), status: String(row.status) as RunStatus,
        error: text(row.error), errorCode: text(row.error_code), errorStep: asObj(row.error_step),
        lockKey: text(row.lock_key), progress: asObj(row.progress) ?? {}, result: json(row.result) ?? null, vars: asObj(row.vars),
        effects: Array.isArray(effects) ? effects : null, instanceId: text(row.instance_id), stepCount: Number(row.step_count ?? 0),
        startedAt: iso(row.started_at), lastActivityAt: iso(row.last_activity_at), endedAt: iso(row.ended_at), durationMs: num(row.duration_ms),
        pausedAt: iso(row.paused_at), wakeAt: iso(row.wake_at), waitKind: text(row.wait_kind), waitRef: text(row.wait_ref),
        resumeSeq: Number(row.resume_seq ?? 0), hasResumeToken: typeof row.resume_token_hash === 'string' && row.resume_token_hash !== '',
        cancelRequested: row.cancel_requested === true, triggerId: text(row.trigger_id),
    };
}

/** A stale window in milliseconds as SQL: rows whose last_activity_at is older are dead. */
const STALE = (param: string): string => `last_activity_at < NOW() - make_interval(secs => ${param}::double precision / 1000)`;
const RECLAIMED = 'The run stopped answering (the server restarted or lost it) and was marked interrupted.';
const PAUSE_OUTLIVED = 'The run waited longer than runs are kept and was ended.';
const PAUSE_ORPHANED = 'The run was on hold for someone whose account no longer exists and was ended.';
/** A server run: a job row a process of ours walks (a background action, or a run a trigger started). */
export const SERVER_RUN_ORIGINS: readonly string[] = Object.freeze(['background', 'trigger']);
const SERVER_RUN = `origin IN ('background', 'trigger')`;
/** A row that holds its lockKey: running, or on hold. */
const HOLDS_LOCK = `status IN ('running', 'paused')`;

export function makeActionRunStore(db: RunDb, { ready = async () => {} }: { ready?: () => Promise<unknown> } = {}) {
    const paused = makePausedRunQueries(db, ready, toRun);
    const { endPauses: _endPauses, ...pausedQueries } = paused;
    /** Start a running row. A live holder of the same lockKey refuses it: `{ ok:false, holder }`. */
    async function insertRunningRun(r: InsertRun): Promise<{ ok: true } | { ok: false; holder: ActionRunRow | null }> {
        await ready();
        return db.tx(async (client) => {
            if (r.lockKey) {
                await client.query(
                    `UPDATE studio_app_action_runs SET status = 'interrupted', ended_at = NOW(), ended_by = 'stale', error = $4
                      WHERE app_id = $1 AND lock_key = $2 AND status = 'running' AND ${STALE('$3')}`,
                    [r.appId, r.lockKey, r.staleMs, RECLAIMED],
                );
            }
            const ins = await client.query(
                `INSERT INTO studio_app_action_runs
                    (id, app_id, owner_user_id, viewer_user_id, action_id, origin, draft, definition_version, dry_run, lock_key, instance_id, trigger_id, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'running')
                 ON CONFLICT DO NOTHING RETURNING id`,
                [r.id, r.appId, r.ownerUserId, r.viewerUserId, r.actionId, r.origin, r.draft, r.definitionVersion, r.dryRun, r.lockKey, r.instanceId, r.triggerId ?? null],
            );
            if (ins.rows.length) return { ok: true as const };
            const { rows } = await client.query(
                `SELECT * FROM studio_app_action_runs WHERE app_id = $1 AND lock_key = $2 AND ${HOLDS_LOCK} LIMIT 1`,
                [r.appId, r.lockKey],
            );
            return { ok: false as const, holder: rows[0] ? toRun(rows[0]) : null };
        });
    }

    /** Running, still-beating rows of an app; with `viewerUserId` only theirs. */
    async function countRunning(appId: string, { viewerUserId, staleMs }: { viewerUserId?: string | null; staleMs: number }): Promise<number> {
        await ready();
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS n FROM studio_app_action_runs
              WHERE app_id = $1 AND status = 'running' AND origin = 'background' AND NOT (${STALE('$3')})
                AND ($2::text IS NULL OR viewer_user_id = $2)`,
            [appId, viewerUserId ?? null, staleMs],
        );
        return Number(rows[0]?.n ?? 0);
    }

    async function updateProgress(id: string, progress: Record<string, unknown>): Promise<void> {
        await ready();
        await db.query(
            `UPDATE studio_app_action_runs SET progress = $2::jsonb, last_activity_at = NOW() WHERE id = $1 AND status = 'running'`,
            [id, JSON.stringify(progress)],
        );
    }

    async function heartbeat(ids: string[]): Promise<number> {
        if (!ids.length) return 0;
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_action_runs SET last_activity_at = NOW() WHERE id = ANY($1::text[]) AND status = 'running'`,
            [ids],
        ));
    }

    /** The end state. Only a running row changes: a swept or finished row is never resurrected. */
    async function finishRun(id: string, f: FinishRun): Promise<boolean> {
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_action_runs
                SET status = $2, result = $3::jsonb, vars = $4::jsonb, effects = $5::jsonb, error = $6, error_code = $7,
                    error_step = $8::jsonb, duration_ms = $9, step_count = $10, truncated = $11, ended_by = $12,
                    ended_at = NOW(), last_activity_at = NOW()
              WHERE id = $1 AND status = 'running'`,
            [id, f.status, toJson(f.result), toJson(f.vars), toJson(f.effects), f.error ?? null, f.errorCode ?? null,
                toJson(f.errorStep), f.durationMs ?? null, f.stepCount ?? 0, f.truncated === true, f.endedBy ?? null],
        )) > 0;
    }

    async function getRun(appId: string, id: string): Promise<ActionRunRow | null> {
        await ready();
        const { rows } = await db.query('SELECT * FROM studio_app_action_runs WHERE app_id = $1 AND id = $2', [appId, id]);
        return rows[0] ? toRun(rows[0]) : null;
    }

    /** One viewer's runs of an app, newest first (at most 50). */
    async function listRunsForViewer(appId: string, viewerUserId: string, opts: { activeOnly?: boolean; actionId?: string | null; limit?: number } = {}): Promise<ActionRunRow[]> {
        await ready();
        const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 20)));
        const { rows } = await db.query(
            `SELECT * FROM studio_app_action_runs
              WHERE app_id = $1 AND viewer_user_id = $2 AND origin = 'background'
                AND ($3::boolean IS NOT TRUE OR ${HOLDS_LOCK})
                AND ($4::text IS NULL OR action_id = $4)
              ORDER BY started_at DESC, id DESC LIMIT ${limit}`,
            [appId, viewerUserId, opts.activeOnly === true, opts.actionId ?? null],
        );
        return rows.map(toRun);
    }

    /** The live holder of `lockKey` in the app, or null (a holder that stopped beating does not count). */
    async function isLockHeld(appId: string, lockKey: string, staleMs: number): Promise<ActionRunRow | null> {
        await ready();
        const { rows } = await db.query(
            `SELECT * FROM studio_app_action_runs
              WHERE app_id = $1 AND lock_key = $2 AND (status = 'paused' OR (status = 'running' AND NOT (${STALE('$3')}))) LIMIT 1`,
            [appId, lockKey, staleMs],
        );
        return rows[0] ? toRun(rows[0]) : null;
    }

    /** Server-run rows nobody beats any more (their replica died) → interrupted. */
    async function markStaleInterrupted(staleMs: number, limit = 200): Promise<number> {
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_action_runs SET status = 'interrupted', ended_at = NOW(), ended_by = 'stale', error = $3
              WHERE id IN (SELECT id FROM studio_app_action_runs
                            WHERE status = 'running' AND ${SERVER_RUN} AND ${STALE('$1')}
                            ORDER BY last_activity_at LIMIT $2)
                AND status = 'running'`,
            [staleMs, Math.max(1, Math.floor(limit)), RECLAIMED],
        ));
    }

    async function markInterrupted(ids: string[], reason: string): Promise<number> {
        if (!ids.length) return 0;
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_action_runs SET status = 'interrupted', ended_at = NOW(), ended_by = 'shutdown', error = $2
              WHERE id = ANY($1::text[]) AND status = 'running'`,
            [ids, reason],
        ));
    }

    /**
     * Payloads nulled after `resultTtlHours`, rows deleted after `retentionDays` (0 = keep), `batch` rows per statement.
     * `onEndedWait` hears every pause this ended that waited for something (an approval request to withdraw);
     * a failure there is the caller's to log and never stops the pass.
     */
    async function pruneRuns({ resultTtlHours, retentionDays, batch = 1000, onEndedWait }: {
        resultTtlHours: number; retentionDays: number; batch?: number; onEndedWait?: (wait: EndedWait) => Promise<unknown>;
    }): Promise<{ nulled: number; deleted: number; expired: number }> {
        await ready();
        const size = Math.max(1, Math.floor(batch));
        let nulled = 0;
        let deleted = 0;
        // A run on hold for a starter whose account was erased (viewer_user_id detached) can never
        // be resumed: it ends here and its state goes. So does a pause older than the retention.
        const ended = [
            ...await paused.endPauses(`viewer_user_id IS NULL`, [], PAUSE_ORPHANED, size),
            ...(retentionDays > 0 ? await paused.endPauses(`started_at < NOW() - make_interval(days => $3::int)`, [retentionDays], PAUSE_OUTLIVED, size) : []),
        ];
        const expired = ended.length;
        if (onEndedWait) {
            for (const wait of ended) if (wait.waitKind) await onEndedWait(wait).catch(() => undefined);
        }
        if (resultTtlHours > 0) {
            nulled = changed(await db.query(
                `UPDATE studio_app_action_runs SET result = NULL, vars = NULL, effects = NULL, progress = '{}'::jsonb, paused_state = NULL
                  WHERE id IN (SELECT id FROM studio_app_action_runs
                                WHERE status NOT IN ('running', 'paused') AND ended_at < NOW() - make_interval(hours => $1::int)
                                  AND (result IS NOT NULL OR vars IS NOT NULL OR effects IS NOT NULL OR progress <> '{}'::jsonb OR paused_state IS NOT NULL)
                                LIMIT $2)`,
                [resultTtlHours, size],
            ));
        }
        if (retentionDays > 0) {
            deleted = changed(await db.query(
                `DELETE FROM studio_app_action_runs
                  WHERE id IN (SELECT id FROM studio_app_action_runs
                                WHERE status NOT IN ('running', 'paused') AND started_at < NOW() - make_interval(days => $1::int) LIMIT $2)`,
                [retentionDays, size],
            ));
        }
        return { nulled, deleted, expired };
    }

    return {
        insertRunningRun, countRunning, updateProgress, heartbeat, finishRun, getRun, listRunsForViewer, isLockHeld,
        markStaleInterrupted, markInterrupted, pruneRuns, ...pausedQueries,
    };
}

export type ActionRunStore = ReturnType<typeof makeActionRunStore>;

let singleton: ActionRunStore | null = null;

/** The store over the app's database, created on first use (awaits the data store's init). */
export function actionRunStore(): ActionRunStore {
    if (!singleton) {
        const dbMod = nodeRequire('../../db') as { run: (sql: string, params?: unknown[]) => Promise<QueryResult>; withTransaction: <T>(fn: (c: Queryable) => Promise<T>) => Promise<T> };
        singleton = makeActionRunStore(
            { query: (sql, params) => dbMod.run(sql, params), tx: (fn) => dbMod.withTransaction(fn) },
            { ready: () => (nodeRequire('./schema') as { initDB: () => Promise<unknown> }).initDB() },
        );
    }
    return singleton;
}
