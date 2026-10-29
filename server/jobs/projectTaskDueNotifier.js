// @typecheck strict
/**
 * Project task due-date notifier — a daily tick that rings the bell of the
 * people a task is given to: the day before it is due, on the day, and every
 * day after that it is still open.
 *
 * A task is reminded once per tier (`notified_due_tier` on the row: `due_1d`,
 * `due_today`, `overdue:<day>` so a late task is reminded daily, once a day);
 * a new due date starts it over (the store clears the marker). A finished task
 * is never reminded. The message names the project only, never the task.
 *
 * Multi-replica safety via a Postgres advisory lock (the learningNudge
 * pattern): every pod ticks, one wins. run() never throws.
 */

'use strict';

const { pool } = require('../db');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_KEY = 0xBEEF7A5; // unique among jobs/* advisory locks
/** @type {NodeJS.Timeout | null} */
let _timer = null;

/** `YYYY-MM-DD` of a moment, in UTC. */
const dayOf = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Which reminder a task is due for today, if any, given the last one sent.
 *
 * @param {string} dueDate     `YYYY-MM-DD`
 * @param {string} today       `YYYY-MM-DD`
 * @param {string} tomorrow    `YYYY-MM-DD`
 * @param {string|null} sent   the marker of the last reminder
 * @returns {{ tier: 'due_1d'|'due_today'|'overdue', marker: string }|null}
 */
function reminderFor(dueDate, today, tomorrow, sent) {
    /** @type {'due_1d'|'due_today'|'overdue'|null} */
    let tier = null;
    /** @type {string | null} */
    let marker = null;
    if (dueDate === tomorrow) { tier = 'due_1d'; marker = 'due_1d'; }
    else if (dueDate === today) { tier = 'due_today'; marker = 'due_today'; }
    else if (dueDate < today) { tier = 'overdue'; marker = `overdue:${today}`; }
    if (!tier || marker === null || sent === marker) return null;
    return { tier, marker };
}

/**
 * `notifier` is the projects/taskNotify surface.
 * @param {{ query?: (sql: string, params: unknown[]) => Promise<{ rows: DueTaskRow[] }>, now?: () => number,
 *   notifier?: { due: Function } }} [deps]
 */
async function run(deps = {}) {
    const query = deps.query || ((/** @type {string} */ sql, /** @type {unknown[]} */ params) => pool.query(sql, params));
    const nowMs = (deps.now || Date.now)();
    const today = dayOf(nowMs);
    const tomorrow = dayOf(nowMs + DAY_MS);
    const notifier = deps.notifier || require('../projects/taskNotify').makeTaskNotifier();
    let sent = 0;
    try {
        // Only what can need a reminder: open, given to someone, due by tomorrow.
        const { rows } = await query(
            `SELECT t.id, t.project_id, t.assignee_ids, to_char(t.due_date, 'YYYY-MM-DD') AS due_day, t.notified_due_tier, p.name AS project_name
               FROM project_tasks t JOIN projects p ON p.id = t.project_id
              WHERE t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date <= $1
                AND jsonb_array_length(t.assignee_ids) > 0
              LIMIT 5000`,
            [tomorrow],
        );
        for (const row of rows) {
            // The day as the database says it: a DATE read into a JS Date shifts by the server's time zone.
            const reminder = reminderFor(row.due_day, today, tomorrow, row.notified_due_tier || null);
            if (!reminder) continue;
            const ids = Array.isArray(row.assignee_ids) ? row.assignee_ids : JSON.parse(row.assignee_ids || '[]');
            const project = { id: row.project_id, name: row.project_name || '' };
            for (const userId of ids) {
                if (await notifier.due({ project, userId, taskId: row.id, tier: reminder.tier })) sent += 1;
            }
            await query('UPDATE project_tasks SET notified_due_tier = $2 WHERE id = $1', [row.id, reminder.marker]);
        }
    } catch (err) {
        log.warn(`[ProjectTaskDue] run failed: ${err && err.message}`);
        return { sent, ok: false };
    }
    return { sent, ok: true };
}

async function tick() {
    const started = Date.now();
    let client = null;
    let acquired = false;
    let ok = true;
    try {
        client = await pool.connect();
        const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
        acquired = !!lock.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        ok = (await run()).ok;
    } catch (err) {
        ok = false;
        log.warn(`[ProjectTaskDue] tick failed: ${err && err.message}`);
    } finally {
        if (client) {
            if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch((e) => bestEffort('jobs/projectTaskDueNotifier:tick', e));
            client.release();
        }
        if (acquired) recordJobRun({ job: 'project_task_due', status: ok ? 'ok' : 'error', durationMs: Date.now() - started });
    }
}

function start() {
    if (_timer) return;
    // First tick 5 minutes after boot, once the stores are up.
    const initial = setTimeout(() => { tick(); }, 5 * 60 * 1000);
    if (initial.unref) initial.unref();
    _timer = setInterval(() => { tick(); }, DAY_MS);
    if (_timer.unref) _timer.unref();
    log.info('[ProjectTaskDue] Started — daily');
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * One open, assigned task due by tomorrow, as run()'s SELECT reads it.
 * @typedef {{ id: string, project_id: string, assignee_ids: string[] | string, due_day: string,
 *   notified_due_tier: string | null, project_name: string | null }} DueTaskRow
 */

module.exports = { start, stop, run, reminderFor };
