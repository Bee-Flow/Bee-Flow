// @typecheck
/**
 * Cowork Store — scheduled work items and their execution history.
 *
 * Cowork is what the Chat ⇄ Work switch produces: a brief that Bee Flow goes
 * off and runs, once or on a repeat, and reports back on.
 *
 * This store deliberately exposes the *same* execution surface as
 * `aiTaskStore` (markRunning / markCompleted / markError / advanceSchedule /
 * updateTask) so `aiTaskRunner.executeTask` can drive a cowork schedule
 * without a second copy of the runner. Everything the runner needs is here;
 * everything extra — the per-run history rows — is a side effect of those same
 * three mark* calls, so the runner never has to know history exists.
 *
 * Scheduling maths (advanceNextRun) is reused from aiTaskStore rather than
 * re-derived: two implementations of "what is next Tuesday" is one too many.
 */

const crypto = require('crypto');
const { run, getOne, getAll } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { buildUpdate } = require('./lib/sqlBuilder');
const { runDdl } = require('./lib/_ddl');
const { advanceNextRun } = require('./aiTaskStore');
const log = require('../telemetry/log');

// The schema lives in ../migrations/cowork-2026-08.js and is applied from here
// (same convention as studioAppStore) so a plain `npm run db:migrate` — which
// only loads stores — brings the tables in.
const initDB = makeStoreInit('CoworkStore', _initDB);

async function _initDB() {
    await require('./ddl/cowork-2026-08').up();
    // CW-13: `produced_output` as its OWN fact alongside `status`.
    //
    // A run that had nothing to report is SUCCESSFUL — it is only empty. Without
    // this column the history cannot tell the two apart: both are
    // status='success', and the screen had to guess the difference from the result text.
    // That guessing should happen once, when the run is closed,
    // and then be stored.
    //
    // NULL is a THIRD value and deliberately not FALSE: rows from before this
    // column simply do not know. Back-filling them as "nothing produced" would
    // invent a statement about the past; the UI reads NULL as
    // unknown and falls back to the text for that.
    //
    // A new column belongs in the idempotent boot DDL of its own store, and
    // then via runDdl — not in a loose migration file and not in a
    // silent catch (boot/bootMigrations.test.js explains that rule).
    await runDdl('coworkStore', [
        'ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS produced_output BOOLEAN',
    ]);
    log.info('[CoworkStore] PostgreSQL initialized');
}

// ── Row mapping ─────────────────────────────────────────

/**
 * @param {string} str
 */
function safeParseJSON(str, fallback = []) {
    if (Array.isArray(str)) return str;
    try { return JSON.parse(str); } catch (_) { return fallback; }
}

/** @param {DbRow.CoworkSchedules | null} r */
function rowToSchedule(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        title: r.title,
        prompt: r.prompt,
        repeatInterval: r.repeat_interval,
        daysOfWeek: r.days_of_week ? safeParseJSON(r.days_of_week, null) : null,
        timeOfDay: r.time_of_day || null,
        nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
        lastResult: r.last_result,
        lastStatus: r.last_status,
        isActive: r.is_active,
        modelTier: r.model_tier,
        toolsEnabled: safeParseJSON(r.tools_enabled, ['agent_search']),
        // null = no per-item restriction; fall back to the user's workspace list.
        enabledApps: r.enabled_apps ? safeParseJSON(r.enabled_apps, null) : null,
        maxResultLength: r.max_result_length,
        runCount: r.run_count,
        timezone: r.timezone,
        agentId: r.agent_id || null,
        conversationId: r.conversation_id || null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

/** @param {DbRow.CoworkRuns | null} r */
function rowToRun(r) {
    if (!r) return null;
    return {
        id: r.id,
        scheduleId: r.schedule_id,
        userId: r.user_id,
        status: r.status,
        triggerKind: r.trigger_kind,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        durationMs: r.duration_ms,
        result: r.result,
        error: r.error,
        // CW-13. Three values, not two: true (something came out), false
        // (successful, nothing to report) and null (row from before the column — not
        // measured). null must NEVER be read as false.
        producedOutput: (r.produced_output === null || r.produced_output === undefined)
            ? null
            : !!r.produced_output,
    };
}

/**
 * Did this successful run have anything to report? (CW-13)
 *
 * The runner never supplies an empty string to markCompleted: if the model produced
 * no text, aiTaskRunner puts its own marker in its place — one italic line in brackets,
 * `_( … )_`, and nothing more. That is the shape that is recognised here, not the Dutch sentence
 * in it: that text is copy and may change (and be translated) without breaking
 * this inference.
 *
 * Deliberately NO substantive judgement on real results — "short text" or
 * "contains no figures" is an opinion, and that does not belong in a column that is read as
 * a fact. Only empty and the marker count as "nothing".
 *
 * Callers that know for certain (the runner knows whether there was tool output)
 * pass `producedOutput` explicitly; this inference is the answer for whoever does not.
 */
function deriveProducedOutput(result) {
    if (result === null || result === undefined) return false;
    const text = String(result).trim();
    if (text === '') return false;
    // Exactly one `_( … )_` block and nothing around it: the "no text result"
    // marker of aiTaskRunner. A real answer that happens to start in italics
    // has text around it and therefore counts as normal.
    if (/^_\([\s\S]*\)_$/.test(text)) return false;
    return true;
}

// ── CRUD ────────────────────────────────────────────────

async function createSchedule({
    userId, title, prompt, repeatInterval, nextRunAt, modelTier,
    timezone, toolsEnabled, agentId, daysOfWeek, timeOfDay, enabledApps,
}) {
    await initDB();
    const id = crypto.randomUUID();
    const daysJson = Array.isArray(daysOfWeek) && daysOfWeek.length > 0 ? JSON.stringify(daysOfWeek) : null;
    await run(
        `INSERT INTO cowork_schedules
           (id, user_id, title, prompt, repeat_interval, next_run_at, model_tier,
            timezone, tools_enabled, agent_id, days_of_week, time_of_day, enabled_apps)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
            id, userId, title, prompt,
            repeatInterval || null,
            nextRunAt,
            modelTier || 'fast',
            timezone || 'Europe/Amsterdam',
            JSON.stringify(toolsEnabled || ['agent_search']),
            agentId || null,
            daysJson,
            timeOfDay || null,
            Array.isArray(enabledApps) ? JSON.stringify(enabledApps) : null,
        ],
    );
    log.info(`[CoworkStore] Created "${title}" for user ${userId}, next run: ${nextRunAt}`);
    return getSchedule(id);
}

/**
 * @param {string} id
 */
async function getSchedule(id) {
    await initDB();
    return rowToSchedule(await getOne('SELECT * FROM cowork_schedules WHERE id = $1', [id]));
}

/**
 * @param {string} userId
 */
async function getSchedules(userId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM cowork_schedules WHERE user_id = $1 ORDER BY created_at DESC',
        [userId],
    );
    return rows.map(rowToSchedule);
}

const FIELD_MAP = {
    title: 'title',
    prompt: 'prompt',
    repeatInterval: 'repeat_interval',
    nextRunAt: 'next_run_at',
    isActive: 'is_active',
    modelTier: 'model_tier',
    timezone: 'timezone',
    toolsEnabled: { col: 'tools_enabled', transform: v => (Array.isArray(v) ? JSON.stringify(v) : v) },
    maxResultLength: 'max_result_length',
    agentId: 'agent_id',
    conversationId: 'conversation_id',
    daysOfWeek: { col: 'days_of_week', transform: v => ((Array.isArray(v) && v.length > 0) ? JSON.stringify(v) : null) },
    timeOfDay: 'time_of_day',
    // An EMPTY list is meaningful here ("this may use nothing"), so unlike
    // daysOfWeek it must survive as '[]' rather than collapse to null.
    enabledApps: { col: 'enabled_apps', transform: v => (Array.isArray(v) ? JSON.stringify(v) : null) },
    // Needed by the reauth pause: resumeNeedsReauthForUser only matches rows
    // whose last_status is 'needs_reauth', so the pause must be able to set it.
    lastStatus: 'last_status',
};

async function updateSchedule(id, updates) {
    await initDB();
    const built = buildUpdate({
        table: 'cowork_schedules',
        updates,
        columnMap: FIELD_MAP,
        where: [{ col: 'id', value: id }],
        quoteCols: true,
    });
    if (!built) return false;
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

/**
 * @param {string} id
 */
async function deleteSchedule(id) {
    await initDB();
    // cowork_runs cascades on the FK — the history goes with the schedule.
    const { rowCount } = await run('DELETE FROM cowork_schedules WHERE id = $1', [id]);
    return rowCount > 0;
}

/**
 * @param {string} userId
 */
async function getScheduleCount(userId) {
    await initDB();
    const r = await getOne(
        'SELECT COUNT(*)::int AS count FROM cowork_schedules WHERE user_id = $1',
        [userId],
    );
    return r?.count || 0;
}

async function deleteUserSchedules(userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM cowork_schedules WHERE user_id = $1', [userId]);
    if (rowCount > 0) log.info(`[CoworkStore] Deleted ${rowCount} schedule(s) for user ${userId}`);
    return rowCount;
}

/**
 * Un-pause everything this user's expired integration took down, i.e. rows
 * left inactive with last_status='needs_reauth'. Called from the OAuth
 * callbacks once they have reconnected; the runner picks them up on the next
 * minute tick. Mirrors aiTaskStore.resumeNeedsReauthForUser — cowork was never
 * wired into that path, so a reconnected user's schedules stayed paused for
 * good. Returns how many were resumed.
 * @param {string} userId
 */
async function resumeNeedsReauthForUser(userId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE cowork_schedules
         SET is_active = TRUE, last_status = 'pending'
         WHERE user_id = $1 AND is_active = FALSE AND last_status = 'needs_reauth'`,
        [userId],
    );
    return rowCount || 0;
}

// ── Execution history ───────────────────────────────────

/**
 * Runs for one schedule, newest first. `limit`/`offset` are clamped here
 * rather than trusted from the query string.
 * @param {string} scheduleId
 */
async function listRuns(scheduleId, { limit = 25, offset = 0 } = {}) {
    await initDB();
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = await getAll(
        `SELECT * FROM cowork_runs
         WHERE schedule_id = $1
         ORDER BY started_at DESC
         LIMIT $2 OFFSET $3`,
        [scheduleId, lim, off],
    );
    return rows.map(rowToRun);
}

/**
 * The start time of the run that this schedule NOW has open, or null (CW-06).
 *
 * The source is the open history row (`finished_at IS NULL`), not
 * `last_status = 'running'`: those two can drift apart — reapStaleRuns
 * closes a stuck row and sets the schedule back to 'error', and a
 * manual run can start just before the tick. "Running since …" must come from
 * the row that is actually open.
 * @param {string} scheduleId
 */
async function getOpenRunStart(scheduleId) {
    await initDB();
    const r = await getOne(
        `SELECT started_at FROM cowork_runs
          WHERE schedule_id = $1 AND finished_at IS NULL
          ORDER BY started_at DESC LIMIT 1`,
        [scheduleId],
    );
    return r?.started_at ? new Date(r.started_at).toISOString() : null;
}

/**
 * The same for EVERY schedule of one user, in one query: an object
 * `{ scheduleId: ISO time }` with only the schedules that have something open.
 *
 * One query per row would make the list talk to the database N+1 times;
 * this is once, on the existing index (user_id, started_at DESC).
 * @param {string} userId
 */
async function getOpenRunStarts(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT schedule_id, MAX(started_at) AS started_at
           FROM cowork_runs
          WHERE user_id = $1 AND finished_at IS NULL
          GROUP BY schedule_id`,
        [userId],
    );
    const out = {};
    for (const r of rows || []) {
        if (r?.schedule_id && r.started_at) out[r.schedule_id] = new Date(r.started_at).toISOString();
    }
    return out;
}

/**
 * The figures behind one schedule (CW-11): how many attempts are in the STORED
 * history, how many of those succeeded, how many went wrong, and how long
 * an attempt took on average.
 *
 * Two things that the caller must keep apart:
 *
 *   - `total` counts the rows that STILL exist. The retention sweep
 *     (deleteRunsOlderThan, 90 days) removes old rows, so after a year this
 *     is less than the number of times this work has ever run. The lifetime
 *     count sits on the schedule itself (`run_count`) and is what "run 42
 *     times" should say.
 *   - `failed` is "closed and not successful" — so also `needs_reauth`, and also
 *     a status name that is added later. A list of error statuses would
 *     silently strike such a new status as "neither successful nor failed".
 *
 * A running run counts in `total` but in neither of the two outcomes, and does not
 * count in the average: its duration is not yet known.
 * @param {string} scheduleId
 */
async function getRunStats(scheduleId) {
    await initDB();
    const r = await getOne(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'success')::int AS success,
                COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND status <> 'success')::int AS failed,
                AVG(duration_ms) FILTER (WHERE finished_at IS NOT NULL) AS avg_duration_ms
           FROM cowork_runs
          WHERE schedule_id = $1`,
        [scheduleId],
    );
    const avg = r?.avg_duration_ms;
    return {
        total: r?.total || 0,
        success: r?.success || 0,
        failed: r?.failed || 0,
        // null stays null: "no attempt completed yet" is something other than
        // "0 ms on average".
        avgDurationMs: (avg === null || avg === undefined) ? null : Math.round(Number(avg)),
    };
}

/**
 * @param {string} scheduleId
 */
async function getRunCount(scheduleId) {
    await initDB();
    const r = await getOne(
        'SELECT COUNT(*)::int AS count FROM cowork_runs WHERE schedule_id = $1',
        [scheduleId],
    );
    return r?.count || 0;
}

/**
 * Close the run this schedule currently has open. Returns the run id, or null
 * when there is nothing open — a manual run-now that raced the scheduler, or a
 * server restart mid-run. Callers treat null as "no history row to update"
 * rather than as an error: losing a history row must never fail the work.
 * @param scheduleId
 * @param {{ status?: string, result?: any, error?: any, producedOutput?: boolean }} opts
 */
async function _closeOpenRun(scheduleId, { status, result, error, producedOutput }) {
    await initDB();
    const openRun = await getOne(
        `SELECT id, started_at FROM cowork_runs
         WHERE schedule_id = $1 AND finished_at IS NULL
         ORDER BY started_at DESC LIMIT 1`,
        [scheduleId],
    );
    if (!openRun) return null;
    // CW-13: the "was there anything to report" judgement falls HERE, once, and is
    // stored. An explicit value from the caller wins; otherwise deriveProducedOutput
    // infers it from what has been stored.
    const produced = typeof producedOutput === 'boolean'
        ? producedOutput
        : deriveProducedOutput(result);
    await run(
        `UPDATE cowork_runs
         SET status = $1,
             result = $2,
             error = $3,
             produced_output = $4,
             finished_at = NOW(),
             duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int
         WHERE id = $5`,
        [status, result ?? null, error ?? null, produced, openRun.id],
    );
    return openRun.id;
}

/**
 * Close runs that have been open far longer than any run could legitimately
 * take, and release the schedule they wedged.
 *
 * A process restart, an OOM kill, or the early `return` in the runner's
 * degraded-beta path all leave `last_status = 'running'` plus a `cowork_runs`
 * row with no `finished_at`. `getDueSchedules` filters out 'running', so that
 * schedule silently stops for good and the history shows a run that never
 * ends. Called from the runner tick, before it asks what is due.
 *
 * The default is generous on purpose: the ceiling on a real run is the tool
 * loop, and a slow agent with a large context can genuinely take many minutes.
 */
async function reapStaleRuns({ olderThanMs = 30 * 60 * 1000 } = {}) {
    await initDB();
    const seconds = Math.max(60, Math.round(Number(olderThanMs) / 1000));
    const message = 'This run was interrupted — the server stopped before it finished.';

    const { rows } = await run(
        `UPDATE cowork_runs
            SET status = 'error',
                error = $2,
                produced_output = FALSE,
                finished_at = NOW(),
                duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int
          WHERE finished_at IS NULL
            AND started_at < NOW() - ($1 || ' seconds')::interval
          RETURNING schedule_id`,
        [String(seconds), message],
    );
    if (rows.length === 0) return 0;

    // Only the schedules that are still claiming to run — a manual retry may
    // already have moved one on, and overwriting that would be worse than the
    // stale row we came to fix.
    await run(
        `UPDATE cowork_schedules
            SET last_status = 'error', last_result = $2
          WHERE id = ANY($1::text[]) AND last_status = 'running'`,
        [rows.map(r => r.schedule_id), message],
    );
    log.warn(`[CoworkStore] Reaped ${rows.length} stale run(s)`);
    return rows.length;
}

/**
 * Retention: delete closed history rows older than the cutoff, one bounded
 * batch at a time — the same subselect-LIMIT shape as
 * automationStore.deleteRunsOlderThan (§WS3.1), which is the repo's canonical
 * run-history reaper.
 *
 * "Closed" is belt-and-braces here: `finished_at IS NOT NULL` is the marker
 * both writers stamp (_closeOpenRun and reapStaleRuns), and 'running' is this
 * table's only open status — together they guarantee an in-flight attempt is
 * never touched, however old its started_at is. That makes the sweep a pure
 * delete-by-age: strictly older-than-cutoff, so running it twice (or from two
 * replicas at once) deletes nothing new — idempotent without an advisory lock.
 *
 * Returns the number of rows deleted so the caller can loop until a batch
 * comes back short (see coworkRunner.pruneOldRuns).
 * @param {string} cutoffIso
 */
async function deleteRunsOlderThan(cutoffIso, { limit = 5000 } = {}) {
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM cowork_runs
          WHERE id IN (
              SELECT id FROM cowork_runs
               WHERE status <> 'running'
                 AND finished_at IS NOT NULL
                 AND finished_at < $1
               ORDER BY finished_at ASC
               LIMIT $2
          )`,
        [cutoffIso, limit],
    );
    return rowCount || 0;
}

// ── Runner surface (mirrors aiTaskStore) ────────────────

async function getDueSchedules() {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM cowork_schedules
         WHERE next_run_at <= NOW()
           AND is_active = TRUE
           AND last_status != 'running'
         ORDER BY next_run_at ASC
         LIMIT 20`,
    );
    return rows.map(rowToSchedule);
}

/**
 * Opens a history row as well as flipping the schedule to 'running'. The
 * runner calls this once per attempt, which is exactly the granularity the
 * history wants.
 */
async function markRunning(id, { triggerKind = 'schedule' } = {}) {
    await initDB();
    const schedule = await getOne('SELECT user_id FROM cowork_schedules WHERE id = $1', [id]);
    if (!schedule) return;
    await run(`UPDATE cowork_schedules SET last_status = 'running' WHERE id = $1`, [id]);
    await run(
        `INSERT INTO cowork_runs (id, schedule_id, user_id, status, trigger_kind)
         VALUES ($1, $2, $3, 'running', $4)`,
        [crypto.randomUUID(), id, schedule.user_id, triggerKind],
    );
}

/**
 * `producedOutput` is optional and overrides the inference from `result` —
 * meant for a caller that knows for certain. The runner does not pass it along today;
 * that extra parameter therefore remains purely additive (the shared
 * runner surface with aiTaskStore calls markCompleted(id, result)).
 * @param id
 * @param result
 * @param {{ producedOutput?: boolean }} [opts]
 */
async function markCompleted(id, result, { producedOutput } = {}) {
    await initDB();
    await run(
        `UPDATE cowork_schedules
         SET last_status = 'success',
             last_result = $1,
             last_run_at = NOW(),
             run_count = run_count + 1
         WHERE id = $2`,
        [result, id],
    );
    await _closeOpenRun(id, { status: 'success', result, producedOutput });
}

async function markError(id, error) {
    await initDB();
    const msg = typeof error === 'string' ? error : error?.message || 'Unknown error';
    // Same convention as aiTaskStore: an expired integration is its own status
    // so the UI can offer "reconnect" instead of a generic failure.
    const status = msg.startsWith('needs_reauth') ? 'needs_reauth' : 'error';
    await run(
        `UPDATE cowork_schedules
         SET last_status = $1,
             last_result = $2,
             last_run_at = NOW(),
             run_count = run_count + 1
         WHERE id = $3`,
        [status, msg, id],
    );
    // A failed run has by definition produced nothing — no inference,
    // no doubt: false.
    await _closeOpenRun(id, { status, error: msg, producedOutput: false });
}

/**
 * @param {string | number | Date} currentNextRun
 */
async function advanceSchedule(id, currentNextRun, interval, daysOfWeek = null) {
    await initDB();
    const next = advanceNextRun(currentNextRun, interval, daysOfWeek);
    if (next) {
        await run('UPDATE cowork_schedules SET next_run_at = $1 WHERE id = $2', [next, id]);
        return next;
    }
    await run('UPDATE cowork_schedules SET is_active = FALSE WHERE id = $1', [id]);
    return null;
}

module.exports = {
    createSchedule,
    getSchedule,
    getSchedules,
    updateSchedule,
    deleteSchedule,
    getScheduleCount,
    deleteUserSchedules,
    resumeNeedsReauthForUser,
    listRuns,
    getRunCount,
    getRunStats,
    getOpenRunStart,
    getOpenRunStarts,
    deriveProducedOutput,
    reapStaleRuns,
    deleteRunsOlderThan,
    getDueSchedules,
    // Runner surface — names match aiTaskStore so executeTask can take either.
    markRunning,
    markCompleted,
    markError,
    advanceSchedule,
    updateTask: updateSchedule,
    // Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
    initDB,
};
