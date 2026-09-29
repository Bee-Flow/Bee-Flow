// @typecheck
/**
 * Reminder Store — PostgreSQL-backed user reminders.
 *
 * Reminders are user-bound. When remind_at is reached, a notification
 * is created via notificationStore. Recurring reminders advance their
 * remind_at automatically.
 *
 * A background checker runs every 60s to fire due reminders.
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

function advanceRemindAt(remindAt, interval) {
    const d = new Date(remindAt);
    switch (interval) {
        case 'daily': d.setDate(d.getDate() + 1); break;
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
        default: return null;
    }
    return d.toISOString();
}

async function processDueReminders() {
    await initDB();
    try {
        const rows = await getAll(
            `SELECT * FROM reminders WHERE remind_at <= NOW() AND is_completed = FALSE`
        );

        if (rows.length === 0) return;

        // Lazy-require to avoid circular deps
        const notificationStore = require('./notificationStore');

        for (const r of rows) {
            // Fire notification
            await notificationStore.createNotification({
                userId: r.user_id,
                category: 'info',
                title: `🔔 Reminder: ${r.title}`,
                message: r.message || '',
            });

            if (r.repeat_interval) {
                // Advance to next occurrence
                const nextAt = advanceRemindAt(r.remind_at, r.repeat_interval);
                if (nextAt) {
                    await run('UPDATE reminders SET remind_at = $1 WHERE id = $2', [nextAt, r.id]);
                } else {
                    await markCompleted(r.id);
                }
            } else {
                // One-time → mark completed
                await markCompleted(r.id);
            }
        }

        if (rows.length > 0) {
            log.info(`[ReminderStore] Fired ${rows.length} reminder(s)`);
        }
    } catch (err) {
        log.error('[ReminderStore] Background checker error:', err.message);
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
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;
