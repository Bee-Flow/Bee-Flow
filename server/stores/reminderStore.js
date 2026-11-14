// @typecheck
/**
 * Reminder Store — PostgreSQL-backed user reminders.
 *
 * Reminders are user-bound. When remind_at is reached, a notification
 * is created via notificationStore. Recurring reminders advance their
 * remind_at automatically.
 *
 * A background checker runs every 60s to fire due reminders, on every
 * replica: a reminder is claimed in the database before it is sent, so each
 * one fires once however many replicas run.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { buildUpdate } = require('./lib/sqlBuilder');
const log = require('../telemetry/log');

const initDB = makeStoreInit('ReminderStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS reminders (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT DEFAULT '',
            remind_at TIMESTAMPTZ NOT NULL,
            repeat_interval TEXT,
            is_completed BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);
        CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(remind_at, is_completed);
    `);
    log.info('[ReminderStore] PostgreSQL initialized');
}

// ── CRUD ─────────────────────────────────────────────────

async function createReminder({ userId, title, message, remindAt, repeatInterval }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO reminders (id, user_id, title, message, remind_at, repeat_interval)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, userId, title, message || '', remindAt, repeatInterval || null]
    );
    log.info(`[ReminderStore] Created reminder "${title}" for user ${userId} at ${remindAt}`);
    return { id, userId, title, message, remindAt, repeatInterval, isCompleted: false };
}

async function getReminders(userId, { includeCompleted = false } = {}) {
    await initDB();
    let query = 'SELECT * FROM reminders WHERE user_id = $1';
    if (!includeCompleted) query += ' AND is_completed = FALSE';
    query += ' ORDER BY remind_at ASC';
    const rows = await getAll(query, [userId]);
    return rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        title: r.title,
        message: r.message,
        remindAt: r.remind_at ? new Date(r.remind_at).toISOString() : null,
        repeatInterval: r.repeat_interval,
        isCompleted: r.is_completed,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
}

async function getReminder(id) {
    await initDB();
    const r = await getOne('SELECT * FROM reminders WHERE id = $1', [id]);
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        title: r.title,
        message: r.message,
        remindAt: r.remind_at ? new Date(r.remind_at).toISOString() : null,
        repeatInterval: r.repeat_interval,
        isCompleted: r.is_completed,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

const REMINDER_COLUMNS = {
    title: 'title',
    message: 'message',
    remindAt: 'remind_at',
    repeatInterval: 'repeat_interval',
    isCompleted: 'is_completed',
};

async function updateReminder(id, updates) {
    await initDB();
    const built = buildUpdate({
        table: 'reminders',
        updates,
        columnMap: REMINDER_COLUMNS,
        where: [{ col: 'id', value: id }],
        quoteCols: true,
    });
    if (!built) return false;
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

async function deleteReminder(id) {
    await initDB();
    const { rowCount } = await run('DELETE FROM reminders WHERE id = $1', [id]);
    return rowCount > 0;
}

async function markCompleted(id) {
    await initDB();
    const { rowCount } = await run('UPDATE reminders SET is_completed = TRUE WHERE id = $1', [id]);
    return rowCount > 0;
}

// ── Background Checker ───────────────────────────────────

/**
 * @param {string | number | Date} remindAt
 * @param {string} interval
 */
function advanceRemindAt(remindAt, interval) {
    const d = new Date(remindAt);
    switch (interval) {
        case 'daily': d.setDate(d.getDate() + 1); break;
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'monthly': {
            // Clamped to the last day of the next month. A bare setMonth
            // overflows: 31 Jan + 1 month is "31 Feb", read as 3 March, so the
            // reminder skipped February and came on the 3rd from then on.
            const day = d.getDate();
            d.setDate(1);
            d.setMonth(d.getMonth() + 1);
            d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
            break;
        }
        default: return null;
    }
    return d.toISOString();
}

/**
 * Claim one due reminder for this pass, before anything is sent: a one-off is
 * completed, a repeating one moves to its next occurrence, in ONE UPDATE that
 * only matches while the row is still as this pass read it. Of several
 * replicas (or passes) that read the same due row, the database lets exactly
 * one through; the others see rowCount 0 and send nothing.
 * @param {{ id: string, remind_at: Date | string, remind_at_exact?: string, repeat_interval?: string | null }} r
 * @returns {Promise<(() => Promise<unknown>) | null>} null when another pass holds it, otherwise the undo of this claim
 */
async function claimDue(r) {
    // The value as Postgres holds it (microseconds): a JS Date would drop them and never compare equal.
    const readAt = r.remind_at_exact || r.remind_at;
    const nextAt = r.repeat_interval ? advanceRemindAt(r.remind_at, r.repeat_interval) : null;
    const claim = nextAt
        ? await run('UPDATE reminders SET remind_at = $1 WHERE id = $2 AND is_completed = FALSE AND remind_at = $3::timestamptz', [nextAt, r.id, readAt])
        : await run('UPDATE reminders SET is_completed = TRUE WHERE id = $1 AND is_completed = FALSE AND remind_at = $2::timestamptz', [r.id, readAt]);
    if (!(claim?.rowCount > 0)) return null;
    return nextAt
        ? () => run('UPDATE reminders SET remind_at = $1::timestamptz WHERE id = $2 AND remind_at = $3::timestamptz', [readAt, r.id, nextAt])
        : () => run('UPDATE reminders SET is_completed = FALSE WHERE id = $1 AND remind_at = $2::timestamptz', [r.id, readAt]);
}

async function processDueReminders() {
    // Runs under setInterval: nothing in here may reject, the schema init included.
    try {
        await initDB();
        const rows = await getAll(
            `SELECT *, remind_at::text AS remind_at_exact FROM reminders WHERE remind_at <= NOW() AND is_completed = FALSE`
        );

        if (rows.length === 0) return;

        // Lazy-require to avoid circular deps
        const notificationStore = require('./notificationStore');

        let fired = 0;
        for (const r of rows) {
            const undo = await claimDue(r);
            if (!undo) continue;
            try {
                await notificationStore.createNotification({
                    userId: r.user_id,
                    category: 'info',
                    title: `🔔 Reminder: ${r.title}`,
                    message: r.message || '',
                });
                fired += 1;
            } catch (err) {
                // Not delivered: hand the reminder back, so the next pass sends it.
                log.error(`[ReminderStore] Reminder ${r.id} not delivered:`, /** @type {Error} */ (err).message);
                await undo().catch((e) => log.warn(`[ReminderStore] Reminder ${r.id} could not be handed back:`, e.message));
            }
        }

        if (fired > 0) {
            log.info(`[ReminderStore] Fired ${fired} reminder(s)`);
        }
    } catch (err) {
        log.error('[ReminderStore] Background checker error:', /** @type {Error} */ (err).message);
    }
}

// Start background checker (every 60s). Both handles are unref'd: a janitor
// timer must not keep the process alive, and a ref'd one at module scope hangs
// `node --test` on any suite that requires this file — the same defect that
// was just found and fixed in core/aiTaskRunner.js. Nothing requires this
// store in a test today, which is the only reason it had not bitten yet.
const _checkerInterval = setInterval(processDueReminders, 60_000);
if (_checkerInterval.unref) _checkerInterval.unref();
// Run once immediately on startup after a short delay
const _firstCheck = setTimeout(processDueReminders, 5_000);
if (_firstCheck.unref) _firstCheck.unref();

module.exports = {
    createReminder,
    getReminders,
    getReminder,
    updateReminder,
    deleteReminder,
    markCompleted,
    processDueReminders,
    // Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
    initDB,
};
