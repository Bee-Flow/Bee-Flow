// @typecheck
/**
 * Notification Store — PostgreSQL-backed notifications for task outcomes.
 *
 * Categories:
 *   - info:     Task completed, items processed
 *   - heads_up: Items awaiting approval, unusual patterns
 *   - urgent:   Task failed, auth expired, errors
 *
 * Uses the shared pg Pool from db.js rather than creating its own pool —
 * this prevents a hidden connection leak where a private Pool would silently
 * consume up to 10 extra connections outside of monitoring.
 *
 * THE POOL IS AN ARGUMENT. `createNotificationStore(pool)` builds the store
 * over anything with `query(sql, params)`, and the module's own export is that
 * factory applied to the shared pool. The tenancy tests hand it a double
 * rather than parking one on db.js's path in require.cache, where every later
 * suite in the process would have picked it up.
 */

const crypto = require('crypto');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT,
    category TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    message TEXT DEFAULT '',
    link TEXT,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill the link column on databases created before it existed.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link TEXT;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_task ON notifications(task_id);
`;

/**
 * @param {{query: Function}} pool - the shared pg Pool, or any double of it.
 * @param {{tag?: string}} [opts] - tag only changes the init error log prefix.
 */
function createNotificationStore(pool, { tag = 'NotificationStore' } = {}) {

    const initDB = makeStoreInit(tag, _initDB);

    async function _initDB() {
        try {
            await pool.query(INIT_SQL);
            log.info('[NotificationStore] PostgreSQL initialized');
        } catch (err) {
            log.error('[NotificationStore] Init error:', err.message);
            throw err;
        }
    }

    // ── CRUD ──────────────────────────────────────────────

    /**
     * Create a notification.
     * @param {{ userId: string, taskId?: string, category?: string, title: string, message?: string, link?: string }} data
     *   link — optional in-app path the client navigates to when the notification is
     *          opened (e.g. `/app/settings/help_support?thread=<id>`).
     */
    async function createNotification({ userId, taskId, category = 'info', title, message = '', link = null }) {
        await initDB();
        const id = crypto.randomUUID();
        // 'cowork' is its own category rather than reusing 'ai_task': the client
        // labels ai_task "Automation", which is a different feature living in a
        // different part of the app, so a cowork result announced itself under
        // someone else's name.
        // 'learning' is the Learning Center's own voice (review nudges) — added
        // v2 so a study reminder doesn't masquerade as generic info.
        const validCategories = ['info', 'heads_up', 'urgent', 'ai_task', 'cowork', 'learning'];
        const cat = validCategories.includes(category) ? category : 'info';

        await pool.query(
            `INSERT INTO notifications (id, user_id, task_id, category, title, message, link)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, userId, taskId || null, cat, title, message, link || null]
        );
        log.info(`[NotificationStore] Created [${cat}]: "${title}" for user ${userId}`);
        return { id, userId, taskId, category: cat, title, message, link: link || null, read: false, created_at: new Date().toISOString() };
    }

    /**
     * Get notifications for a user.
     * @param {string} userId
     * @param {{ unreadOnly?: boolean, limit?: number }} options
     */
    async function getNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
        await initDB();
        let query = 'SELECT * FROM notifications WHERE user_id = $1';
        /** @type {any[]} */
        const params = [userId];

        if (unreadOnly) {
            query += ' AND read = FALSE';
        }

        query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
        params.push(limit);

        const { rows } = await pool.query(query, params);
        return rows.map(r => ({
            ...r,
            created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
        }));
    }

    /**
     * Get unread count for a user.
     */
    async function getUnreadCount(userId) {
        await initDB();
        const { rows } = await pool.query(
            'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = FALSE',
            [userId]
        );
        return rows[0]?.count || 0;
    }

    /**
     * Tenancy scope for the single-row mutations — fails CLOSED.
     *
     * A notification id is unguessable, not an authorization token, so `WHERE id =
     * $1` alone lets a leaked id (a log line, a Referer, a shared screen) silence
     * or destroy another user's alert. Every statement in this store therefore
     * carries `user_id`, and these two take it as a required argument.
     *
     * There is deliberately no "unscoped" branch: a missing scope is a programming
     * error and throws, because the alternative — silently running the statement
     * globally — is exactly the vulnerability this predicate exists to close. An
     * empty string is accepted as a scope value: `user_id` is NOT NULL and is
     * written from a real user id, so it matches nothing and the call reports
     * "not found" rather than widening.
     *
     * @param {string} fn calling function name, for the error message
     * @param {unknown} userId
     * @returns {string} the validated scope
     */
    function requireUserScope(fn, userId) {
        if (typeof userId !== 'string') {
            throw new TypeError(
                `[NotificationStore] ${fn}(id, userId) requires a userId scope — refusing to run unscoped `
                + `(got ${userId === null ? 'null' : typeof userId})`
            );
        }
        return userId;
    }

    /**
     * Mark a single notification as read.
     *
     * @param {string} id
     * @param {string} userId REQUIRED tenancy scope — see {@link requireUserScope}.
     *   Throws a TypeError when absent, so a caller that loses its session value
     *   fails loudly instead of degrading to a global UPDATE.
     * @returns {Promise<boolean>} true when a row was updated (false when the id is
     *   unknown or is not this user's).
     */
    async function markRead(id, userId) {
        requireUserScope('markRead', userId);
        await initDB();
        const { rowCount } = await pool.query(
            'UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2',
            [id, userId]
        );
        return rowCount > 0;
    }

    /**
     * Mark all notifications as read for a user.
     */
    async function markAllRead(userId) {
        await initDB();
        const { rowCount } = await pool.query(
            'UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE',
            [userId]
        );
        return rowCount;
    }

    /**
     * Delete a notification.
     *
     * @param {string} id
     * @param {string} userId REQUIRED tenancy scope — see {@link requireUserScope}.
     * @returns {Promise<boolean>} true when a row was deleted (false when the id is
     *   unknown or is not this user's).
     */
    async function deleteNotification(id, userId) {
        requireUserScope('deleteNotification', userId);
        await initDB();
        const { rowCount } = await pool.query(
            'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
            [id, userId]
        );
        return rowCount > 0;
    }

    /**
     * Delete all notifications for a user (used during user deletion).
     */
    async function deleteUserNotifications(userId) {
        await initDB();
        const { rowCount } = await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
        if (rowCount > 0) log.info(`[NotificationStore] Deleted ${rowCount} notification(s) for user ${userId}`);
        return rowCount;
    }

    return {
        // Awaitbare init-ingang voor migrateDb en boot/storeSchemas.
        initDB,
        createNotification,
        getNotifications,
        getUnreadCount,
        markRead,
        markAllRead,
        deleteNotification,
        deleteUserNotifications,
    };
}

module.exports = createNotificationStore(require('../db').pool);
module.exports.createNotificationStore = createNotificationStore;
