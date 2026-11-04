/**
 * stores/studioAppData/runLogStore.mts: the run log's queries over the run table
 * (studio_app_action_runs, shared with background jobs, ./actionRuns.mts) and its step rows
 * (studio_app_action_run_steps, DDL in ./schema.js).
 *
 *   insertRun        a run row of the log (origin click | public | mcp | test | mailbox_hook)
 *   claimClickRun    the row of a browser run by its client run key: created on the first step,
 *                    reopened by the next one of the SAME actor; another actor's key → null
 *   markInFlight     a browser step started (the idle rule waits for it)
 *   appendSteps      step rows + the run's counters in one transaction (tokens, cost per
 *                    currency, first unhandled error); rows past `maxSteps` only count
 *   finishLogged     the end of a run the log started (never resurrects)
 *   endClickRun      the browser's end report for its run key (same actor only)
 *   listRuns / getSteps / actorFacets
 *   closeIdleRuns    browser runs that never reported their end → success / error, ended_by idle
 *   pruneOverflow    the newest `maxPerApp` runs per app are kept, older finished ones deleted
 *
 * Background rows (origin background) are package 3's: never claimed, idle-closed or ended here.
 * Every read is keyed by the app id the caller has ALREADY authorised. Display names come from
 * the users table when it answers; e-mail addresses are never read.
 */

import { createRequire } from 'node:module';
import type { Queryable, RunDb } from './actionRuns.mts';
import { AGO, changed, clampInt, costMap, displayName, effectiveStatusSql, text, toListRow, toStoredStep } from './runLogRows.mts';
import type { ListFilter, NewLoggedRun, Row, RunListRow, StepRecord, StoredStep } from './runLogRows.mts';

export { BROWSER_ORIGINS, RUN_ORIGINS } from './runLogRows.mts';
export type { AiUsage, ListFilter, NewLoggedRun, RunListRow, RunOrigin, StepRecord, StoredStep } from './runLogRows.mts';


const nodeRequire = createRequire(import.meta.url);

export function makeRunLogStore(db: RunDb, { ready = async () => {} }: { ready?: () => Promise<unknown> } = {}) {
    async function namesOf(ids: string[]): Promise<Map<string, string | null>> {
        const out = new Map<string, string | null>();
        if (!ids.length) return out;
        try {
            const { rows } = await db.query('SELECT id, "displayName", username FROM users WHERE id = ANY($1::text[])', [ids]);
            for (const r of rows) out.set(String(r.id), displayName(r));
        } catch { /* no users table answers (a store test): the list shows no names */ }
        return out;
    }

    async function insertRun(r: NewLoggedRun): Promise<boolean> {
        await ready();
        const res = await db.query(
            `INSERT INTO studio_app_action_runs
                (id, app_id, owner_user_id, viewer_user_id, visitor_key, action_id, origin, draft, definition_version, dry_run,
                 client, client_run_key, tracked, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'running')
             ON CONFLICT DO NOTHING RETURNING id`,
            [r.id, r.appId, r.ownerUserId, r.viewerUserId, r.visitorKey ?? null, r.actionId, r.origin, r.draft,
                r.definitionVersion, r.dryRun === true, r.client ?? null, r.clientRunKey ?? null, r.tracked !== false],
        );
        return res.rows.length > 0;
    }

    /**
     * The run of a browser run key. The first step creates it; a later step of the SAME actor and
     * action reopens it (also one the idle rule closed). A key someone else holds → null: that
     * step is logged on its own, never into another person's run.
     */
    async function claimClickRun(r: NewLoggedRun & { clientRunKey: string }): Promise<string | null> {
        await ready();
        return db.tx(async (client) => {
            const sameActor = `action_id = $3 AND origin = $4 AND viewer_user_id IS NOT DISTINCT FROM $5 AND visitor_key IS NOT DISTINCT FROM $6`;
            const reopened = await client.query(
                `UPDATE studio_app_action_runs
                    SET in_flight = TRUE, last_activity_at = NOW(),
                        status = CASE WHEN ended_by = 'idle' THEN 'running' ELSE status END,
                        ended_at = CASE WHEN ended_by = 'idle' THEN NULL ELSE ended_at END,
                        ended_by = CASE WHEN ended_by = 'idle' THEN NULL ELSE ended_by END
                  WHERE app_id = $1 AND client_run_key = $2 AND ${sameActor} AND (status = 'running' OR ended_by = 'idle')
                  RETURNING id`,
                [r.appId, r.clientRunKey, r.actionId, r.origin, r.viewerUserId, r.visitorKey ?? null],
            );
            if (reopened.rows.length) return String(reopened.rows[0].id);
            const ins = await client.query(
                `INSERT INTO studio_app_action_runs
                    (id, app_id, owner_user_id, viewer_user_id, visitor_key, action_id, origin, draft, definition_version, dry_run,
                     client, client_run_key, tracked, status, in_flight)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, $10, $11, TRUE, 'running', TRUE)
                 ON CONFLICT DO NOTHING RETURNING id`,
                [r.id, r.appId, r.ownerUserId, r.viewerUserId, r.visitorKey ?? null, r.actionId, r.origin, r.draft,
                    r.definitionVersion, r.client ?? null, r.clientRunKey],
            );
            return ins.rows.length ? String(ins.rows[0].id) : null;
        });
    }

    async function markInFlight(runId: string): Promise<void> {
        await ready();
        await db.query(`UPDATE studio_app_action_runs SET in_flight = TRUE, last_activity_at = NOW() WHERE id = $1 AND status = 'running'`, [runId]);
    }

    /** Step rows and the run's counters, in one transaction. Past `maxSteps` (0 = unlimited) a step only counts. */
    async function appendSteps(runId: string, steps: StepRecord[], { maxSteps }: { maxSteps: number }): Promise<void> {
        if (!steps.length) return;
        await ready();
        await db.tx(async (client: Queryable) => {
            const { rows } = await client.query(
                'SELECT step_count, cost_by_currency, error FROM studio_app_action_runs WHERE id = $1 FOR UPDATE', [runId],
            );
            if (!rows.length) return;
            const base = Number(rows[0].step_count ?? 0);
            const cost = costMap(rows[0].cost_by_currency);
            let failed = 0; let handled = 0; let calls = 0; let prompt = 0; let completion = 0; let truncated = false;
            const firstError: StepRecord | null = rows[0].error ? null : (steps.find((s) => s.status === 'error' && !s.handled) ?? null);
            for (let i = 0; i < steps.length; i += 1) {
                const s = steps[i];
                const seq = base + i + 1;
                if (s.status === 'error') { if (s.handled) handled += 1; else failed += 1; }
                if (s.ai) {
                    calls += clampInt(s.ai.calls); prompt += clampInt(s.ai.promptTokens); completion += clampInt(s.ai.completionTokens);
                    if (s.ai.currency && /^[A-Z]{3}$/.test(s.ai.currency) && Number.isFinite(s.ai.cost)) {
                        cost[s.ai.currency] = Math.round(((cost[s.ai.currency] ?? 0) + Number(s.ai.cost)) * 1e6) / 1e6;
                    }
                }
                if (maxSteps && seq > maxSteps) { truncated = true; continue; }
                await client.query(
                    `INSERT INTO studio_app_action_run_steps
                        (run_id, seq, action_id, step_index, path, iteration, kind, status, error, error_code, attempts, handled, mocked,
                         started_at, duration_ms, model, model_tier, ai_calls, prompt_tokens, completion_tokens, cost, cost_currency)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14::double precision / 1000), $15,
                             $16, $17, $18, $19, $20, $21, $22)
                     ON CONFLICT DO NOTHING`,
                    [runId, seq, s.actionId, s.stepIndex, s.path.slice(0, 500), s.iteration, s.kind.slice(0, 60), s.status, s.error,
                        s.errorCode ? s.errorCode.slice(0, 60) : null, s.attempts, s.handled, s.mocked, s.startedAt, clampInt(s.durationMs),
                        s.ai?.model ? s.ai.model.slice(0, 200) : null, s.ai?.tier ? s.ai.tier.slice(0, 60) : null, clampInt(s.ai?.calls),
                        clampInt(s.ai?.promptTokens), clampInt(s.ai?.completionTokens),
                        s.ai && Number.isFinite(s.ai.cost) ? s.ai.cost : null, s.ai?.currency ?? null],
                );
            }
            const last = steps[steps.length - 1];
            await client.query(
                `UPDATE studio_app_action_runs
                    SET step_count = step_count + $2, failed_steps = failed_steps + $3, handled_errors = handled_errors + $4,
                        ai_calls = ai_calls + $5, prompt_tokens = prompt_tokens + $6, completion_tokens = completion_tokens + $7,
                        cost_by_currency = $8::jsonb, truncated = truncated OR $9, last_step_status = $10, in_flight = FALSE,
                        last_activity_at = NOW(),
                        error = COALESCE(error, $11), error_code = COALESCE(error_code, $12),
                        error_step = COALESCE(error_step, $13::jsonb)
                  WHERE id = $1`,
                [runId, steps.length, failed, handled, calls, prompt, completion, JSON.stringify(cost), truncated,
                    last.status.slice(0, 20), firstError?.error ?? null, firstError?.errorCode ?? null,
                    firstError ? JSON.stringify({ path: firstError.path, kind: firstError.kind, stepIndex: firstError.stepIndex, actionId: firstError.actionId }) : null],
            );
        });
    }

    /** The end of a run the log started. Only a running row changes; the duration is measured by the caller. */
    async function finishLogged(runId: string, f: { status: string; error?: string | null; errorCode?: string | null; durationMs: number; endedBy?: string | null; truncated?: boolean }): Promise<boolean> {
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_action_runs
                SET status = $2, error = COALESCE(error, $3), error_code = COALESCE(error_code, $4), duration_ms = $5,
                    ended_by = $6, truncated = truncated OR $7, in_flight = FALSE, ended_at = NOW(), last_activity_at = NOW()
              WHERE id = $1 AND status = 'running'`,
            [runId, f.status, f.error ?? null, f.errorCode ?? null, clampInt(f.durationMs), f.endedBy ?? null, f.truncated === true],
        )) > 0;
    }

    /** The browser's end report. Same actor only; a run the idle rule closed takes the reported status. */
    async function endClickRun(appId: string, clientRunKey: string, actor: { viewerUserId: string | null; visitorKey?: string | null }, o: { status: string; error?: string | null; handled?: boolean }): Promise<boolean> {
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_action_runs
                SET status = $5, ended_by = 'client', in_flight = FALSE, ended_at = NOW(), last_activity_at = NOW(),
                    duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int),
                    error = CASE WHEN $5 = 'error' THEN COALESCE(error, $6) ELSE error END,
                    handled_errors = CASE WHEN $7 AND handled_errors = 0 THEN 1 ELSE handled_errors END
              WHERE app_id = $1 AND client_run_key = $2 AND origin IN ('click', 'public')
                AND viewer_user_id IS NOT DISTINCT FROM $3 AND visitor_key IS NOT DISTINCT FROM $4
                AND (status = 'running' OR ended_by = 'idle')`,
            [appId, clientRunKey, actor.viewerUserId, actor.visitorKey ?? null, o.status, o.error ?? null, o.handled === true],
        )) > 0;
    }

    function listWhere(f: ListFilter, params: unknown[]): string {
        const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };
        const where = [`r.app_id = ${add(f.appId)}`];
        if (f.actionId) where.push(`r.action_id = ${add(f.actionId)}`);
        if (f.origins && f.origins.length) where.push(`r.origin = ANY(${add(f.origins)}::text[])`);
        if (f.since) where.push(`r.started_at >= ${add(f.since)}::timestamptz`);
        if (f.actor?.kind === 'user') where.push(`r.viewer_user_id = ${add(f.actor.userId)}`);
        if (f.actor?.kind === 'others') where.push(`r.viewer_user_id IS NOT NULL AND r.viewer_user_id <> ${add(f.actor.userId)}`);
        if (f.actor?.kind === 'visitors') where.push(`r.visitor_key IS NOT NULL`);
        if (f.actor?.kind === 'system') where.push(`r.viewer_user_id IS NULL AND r.visitor_key IS NULL`);
        if (f.before) where.push(`(r.started_at, r.id) < (${add(f.before.startedAt)}::timestamptz, ${add(f.before.id)})`);
        return where.join(' AND ');
    }

    /** Newest first, keyset paged on (started_at, id). `status` filters the EFFECTIVE status. */
    async function listRuns(f: ListFilter): Promise<RunListRow[]> {
        await ready();
        const params: unknown[] = [f.idleMs, f.staleMs];
        const eff = effectiveStatusSql('$1', '$2');
        const where = listWhere(f, params);
        const statusClause = f.status ? ` AND (${eff}) = $${params.push(f.status)}` : '';
        const limit = Math.max(1, Math.min(200, Math.floor(f.limit)));
        const { rows } = await db.query(
            `SELECT r.*, (${eff}) AS effective_status,
                    CASE WHEN (${eff}) <> r.status THEN 'idle' ELSE r.ended_by END AS effective_ended_by,
                    CASE WHEN r.duration_ms IS NULL AND (${eff}) <> r.status
                         THEN GREATEST(0, (EXTRACT(EPOCH FROM (r.last_activity_at - r.started_at)) * 1000)::int)
                         ELSE r.duration_ms END AS effective_duration_ms
               FROM studio_app_action_runs r
              WHERE ${where}${statusClause}
              ORDER BY r.started_at DESC, r.id DESC LIMIT ${limit}`,
            params,
        );
        const ids = [...new Set(rows.map((r) => text(r.viewer_user_id)).filter((v): v is string => !!v))];
        const names = await namesOf(ids);
        return rows.map((r) => toListRow(r, names));
    }

    async function getLoggedRun(appId: string, runId: string, opts: { idleMs: number; staleMs: number }): Promise<RunListRow | null> {
        await ready();
        const eff = effectiveStatusSql('$3', '$4');
        const { rows } = await db.query(
            `SELECT r.*, (${eff}) AS effective_status,
                    CASE WHEN (${eff}) <> r.status THEN 'idle' ELSE r.ended_by END AS effective_ended_by,
                    CASE WHEN r.duration_ms IS NULL AND (${eff}) <> r.status
                         THEN GREATEST(0, (EXTRACT(EPOCH FROM (r.last_activity_at - r.started_at)) * 1000)::int)
                         ELSE r.duration_ms END AS effective_duration_ms
               FROM studio_app_action_runs r WHERE r.app_id = $1 AND r.id = $2`,
            [appId, runId, opts.idleMs, opts.staleMs],
        );
        if (!rows.length) return null;
        const viewer = text(rows[0].viewer_user_id);
        return toListRow(rows[0], await namesOf(viewer ? [viewer] : []));
    }

    async function getSteps(runId: string, limit = 1000): Promise<StoredStep[]> {
        await ready();
        const { rows } = await db.query(
            `SELECT * FROM studio_app_action_run_steps WHERE run_id = $1 ORDER BY seq LIMIT ${Math.max(1, Math.floor(limit))}`, [runId],
        );
        return rows.map(toStoredStep);
    }

    /** Who ran the app's actions (for the filter): at most 50 signed-in people, plus whether visitors / the system ran any. */
    async function actorFacets(appId: string): Promise<{ users: Array<{ userId: string; name: string | null; runs: number }>; visitors: boolean; system: boolean }> {
        await ready();
        const { rows } = await db.query(
            `SELECT viewer_user_id, COUNT(*)::int AS n FROM studio_app_action_runs
              WHERE app_id = $1 AND viewer_user_id IS NOT NULL GROUP BY viewer_user_id ORDER BY n DESC LIMIT 50`,
            [appId],
        );
        const flags = await db.query(
            `SELECT BOOL_OR(visitor_key IS NOT NULL) AS visitors, BOOL_OR(viewer_user_id IS NULL AND visitor_key IS NULL) AS system
               FROM studio_app_action_runs WHERE app_id = $1`,
            [appId],
        );
        const names = await namesOf(rows.map((r) => String(r.viewer_user_id)));
        return {
            users: rows.map((r) => ({ userId: String(r.viewer_user_id), name: names.get(String(r.viewer_user_id)) ?? null, runs: Number(r.n) })),
            visitors: flags.rows[0]?.visitors === true, system: flags.rows[0]?.system === true,
        };
    }

    /** Browser runs that never reported their end, finished from their steps (ended_by idle). */
    async function closeIdleRuns({ idleMs, staleMs, limit = 500 }: { idleMs: number; staleMs: number; limit?: number }): Promise<number> {
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_action_runs r
                SET status = CASE WHEN r.failed_steps > 0 THEN 'error' ELSE 'success' END, ended_by = 'idle', in_flight = FALSE,
                    ended_at = r.last_activity_at,
                    duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (r.last_activity_at - r.started_at)) * 1000)::int)
              WHERE r.id IN (SELECT id FROM studio_app_action_runs
                              WHERE status = 'running' AND origin IN ('click', 'public')
                                AND ((NOT in_flight AND last_activity_at < ${AGO('$1')}) OR last_activity_at < ${AGO('$2')})
                              ORDER BY last_activity_at LIMIT $3)
                AND r.status = 'running'`,
            [idleMs, staleMs, Math.max(1, Math.floor(limit))],
        ));
    }

    /** Per app, everything older than its newest `maxPerApp` finished runs is deleted (0 = no ceiling). */
    async function pruneOverflow({ maxPerApp, batch = 1000 }: { maxPerApp: number; batch?: number }): Promise<number> {
        if (!maxPerApp) return 0;
        await ready();
        return changed(await db.query(
            `DELETE FROM studio_app_action_runs WHERE id IN (
                SELECT id FROM (
                    SELECT id, status, ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY started_at DESC, id DESC) AS rn
                      FROM studio_app_action_runs
                ) ranked WHERE rn > $1 AND status <> 'running' LIMIT $2)`,
            [Math.floor(maxPerApp), Math.max(1, Math.floor(batch))],
        ));
    }

    return {
        insertRun, claimClickRun, markInFlight, appendSteps, finishLogged, endClickRun, listRuns, getLoggedRun, getSteps,
        actorFacets, closeIdleRuns, pruneOverflow,
    };
}

export type RunLogStore = ReturnType<typeof makeRunLogStore>;

let singleton: RunLogStore | null = null;

/** The store over the app's database, created on first use (awaits the data store's init). */
export function runLogStore(): RunLogStore {
    if (!singleton) {
        const dbMod = nodeRequire('../../db') as { run: (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }>; withTransaction: <T>(fn: (c: Queryable) => Promise<T>) => Promise<T> };
        singleton = makeRunLogStore(
            { query: (sql, params) => dbMod.run(sql, params), tx: (fn) => dbMod.withTransaction(fn) },
            { ready: () => (nodeRequire('./schema') as { initDB: () => Promise<unknown> }).initDB() },
        );
    }
    return singleton;
}
