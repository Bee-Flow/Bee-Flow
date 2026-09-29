// @typecheck
/**
 * automation_notification_events — every notification a routine sent, or
 * held back (Studio → Automations handoff 5). The table comes from
 * migrations/automation-handoff5-2026-09.js; the rules live in
 * core/automationRunner/runNotifications.js (direct delivery and throttle) and
 * jobs/automationDigest.js (bundles and the daily summary).
 *
 * One row per recipient per channel per message:
 *   recipient_user_id  a Bee Flow user id, or `talk:<roomToken>` for a Talk
 *                      message (Talk goes to a conversation, not a person)
 *   channel            'bell' | 'email' | 'talk', or 'digest' for an event
 *                      that waits for the daily summary
 *   delivered_at       set when the channel accepted it; NULL = failed or held
 *   bundled            TRUE = held back (throttle, or waiting for the digest)
 *   digest_sent_at     set when a held row was reported (bundle message or
 *                      daily summary), so it is never reported twice
 *
 * All rows of one message share `created_at` (the caller passes one Date), so
 * "how many messages in the last hour" is COUNT(DISTINCT created_at).
 *
 * Built by a factory over a `{ query }` handle, like shares.js, so the pg test
 * runs it against PGlite without mocking the module system.
 */

'use strict';

const crypto = require('crypto');

function newEventId() {
    return 'ane_' + crypto.randomBytes(12).toString('hex');
}

function iso(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function rowToEvent(r) {
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        runId: r.run_id ?? null,
        event: r.event,
        recipient: r.recipient_user_id,
        channel: r.channel,
        urgency: r.urgency,
        createdAt: iso(r.created_at),
        deliveredAt: iso(r.delivered_at),
        bundled: !!r.bundled,
        digestSentAt: iso(r.digest_sent_at),
    };
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeNotificationEventsStore(db, { ready = async () => {} } = {}) {
    /**
     * Write attempts. Each row: { automationId, runId?, event, recipient,
     * channel, urgency?, createdAt (Date|ISO), delivered (bool), bundled? }.
     * Returns the number of rows written.
     *
     * @param {Array<{ automationId: string, runId?: string|null, event: string, recipient: string, channel: string, urgency?: string, createdAt: Date|string, delivered?: boolean, bundled?: boolean }>} rows
     */
    async function recordNotificationEvents(rows) {
        await ready();
        const list = (Array.isArray(rows) ? rows : []).filter(r => r && r.automationId && r.event && r.recipient && r.channel);
        if (!list.length) return 0;
        const values = [];
        const params = [];
        for (const r of list) {
            const created = iso(r.createdAt) || new Date().toISOString();
            const base = params.length;
            params.push(
                newEventId(), r.automationId, r.runId || null, r.event, String(r.recipient), r.channel,
                r.urgency || 'normal', created, r.delivered ? created : null, !!r.bundled,
            );
            values.push(`(${Array.from({ length: 10 }, (_, i) => `$${base + i + 1}`).join(', ')})`);
        }
        await db.query(
            `INSERT INTO automation_notification_events
                (id, automation_id, run_id, event, recipient_user_id, channel, urgency, created_at, delivered_at, bundled)
             VALUES ${values.join(', ')}`,
            params,
        );
        return list.length;
    }

    /**
     * How many messages (not rows) this routine sent this recipient for this
     * event since `since`. Held-back rows do not count; failed ones do (an
     * attempt still counts toward the cap, or a broken channel would never be
     * throttled).
     *
     * @param {{ automationId: string, event: string, recipient: string, since: Date|string }} p
     */
    async function countRecentMessages({ automationId, event, recipient, since }) {
        await ready();
        const r = await db.query(
            `SELECT COUNT(DISTINCT created_at)::int AS n
               FROM automation_notification_events
              WHERE automation_id = $1 AND event = $2 AND recipient_user_id = $3
                AND bundled = FALSE AND created_at >= $4`,
            [automationId, event, String(recipient), iso(since)],
        );
        return Number(r.rows[0]?.n) || 0;
    }

    /**
     * Throttled rows waiting for their "n more" message, grouped per routine,
     * event and recipient. Rows held for the digest (channel 'digest') are
     * not bundles and are left alone.
     *
     * @param {{ limit?: number }} [opts]
     */
    async function listPendingBundles({ limit = 200 } = {}) {
        await ready();
        const r = await db.query(
            `SELECT automation_id, event, recipient_user_id,
                    ARRAY_AGG(DISTINCT channel) AS channels,
                    COUNT(DISTINCT created_at)::int AS n,
                    MIN(created_at) AS first_at,
                    MAX(created_at) AS last_at,
                    MAX(urgency) AS urgency,
                    ARRAY_AGG(id) AS ids
               FROM automation_notification_events
              WHERE bundled = TRUE AND digest_sent_at IS NULL AND channel <> 'digest'
              GROUP BY automation_id, event, recipient_user_id
              ORDER BY MIN(created_at)
              LIMIT $1`,
            [Math.max(1, Math.min(1000, Number(limit) || 200))],
        );
        return r.rows.map(row => ({
            automationId: row.automation_id,
            event: row.event,
            recipient: row.recipient_user_id,
            channels: Array.isArray(row.channels) ? row.channels : [],
            count: Number(row.n) || 0,
            firstAt: iso(row.first_at),
            lastAt: iso(row.last_at),
            urgency: row.urgency || 'normal',
            ids: Array.isArray(row.ids) ? row.ids : [],
        }));
    }

    /** Mark held rows as reported (bundle message or daily summary). */
    async function markEventsReported(ids, at = new Date()) {
        await ready();
        const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
        if (!list.length) return 0;
        const r = await db.query(
            `UPDATE automation_notification_events SET digest_sent_at = $2
              WHERE id = ANY($1::text[]) AND digest_sent_at IS NULL`,
            [list, iso(at)],
        );
        return r.rowCount ?? 0;
    }

    /**
     * Held rows a digest should report and then mark: every unreported
     * held row (throttled or digest-only) of these routines for this
     * recipient.
     *
     * @param {{ recipient: string, automationIds: string[] }} p
     */
    async function listHeldForDigest({ recipient, automationIds }) {
        await ready();
        if (!automationIds?.length) return [];
        const r = await db.query(
            `SELECT * FROM automation_notification_events
              WHERE recipient_user_id = $1 AND automation_id = ANY($2::text[])
                AND bundled = TRUE AND digest_sent_at IS NULL
              ORDER BY created_at`,
            [String(recipient), automationIds],
        );
        return r.rows.map(rowToEvent);
    }

    /**
     * When this recipient last got (or was checked for) a daily summary
     * covering any of these routines, or null.
     *
     * @param {string} recipient
     * @param {string[]} automationIds
     */
    async function lastDigestAt(recipient, automationIds) {
        await ready();
        if (!automationIds?.length) return null;
        const r = await db.query(
            `SELECT MAX(created_at) AS at FROM automation_notification_events
              WHERE recipient_user_id = $1 AND event = 'digest' AND automation_id = ANY($2::text[])`,
            [String(recipient), automationIds],
        );
        return iso(r.rows[0]?.at);
    }

    /**
     * Routines with the daily summary switched on (working copy; notification
     * settings are not part of what a run executes). Trash excluded.
     */
    async function listDigestAutomations({ limit = 2000 } = {}) {
        await ready();
        const r = await db.query(
            `SELECT id, user_id, organization_id, title, schedule_tz,
                    definition_json -> 'notificationSettings' AS notification_settings
               FROM automations
              WHERE COALESCE(kind, 'automation') = 'automation'
                AND deleted_at IS NULL
                AND definition_json -> 'notificationSettings' -> 'digest' ->> 'enabled' = 'true'
              ORDER BY id
              LIMIT $1`,
            [Math.max(1, Number(limit) || 2000)],
        );
        return r.rows.map(row => {
            let settings = row.notification_settings;
            if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch { settings = null; } }
            return {
                id: row.id,
                userId: row.user_id,
                organizationId: row.organization_id ?? null,
                title: row.title,
                scheduleTz: row.schedule_tz || 'Europe/Amsterdam',
                notificationSettings: settings && typeof settings === 'object' ? settings : null,
            };
        });
    }

    /**
     * Per routine: finished runs since `since` and how many of them failed
     * (live, not tests, journey heads only), plus the runs waiting for
     * someone right now. Routines without runs are absent from the Map.
     *
     * @param {{ automationIds: string[], since: Date|string }} p
     * @returns {Promise<Map<string, { runs: number, failures: number, waiting: number }>>}
     */
    async function digestRunStats({ automationIds, since }) {
        await ready();
        const out = new Map();
        if (!automationIds?.length) return out;
        const r = await db.query(
            `SELECT automation_id,
                    COUNT(*) FILTER (WHERE created_at >= $2)::int AS runs,
                    COUNT(*) FILTER (WHERE created_at >= $2 AND status = 'error')::int AS failures,
                    COUNT(*) FILTER (WHERE status IN ('awaiting_approval', 'awaiting_form', 'awaiting_confirm'))::int AS waiting
               FROM automation_runs
              WHERE automation_id = ANY($1::text[])
                AND COALESCE(mode, 'live') = 'live'
                AND COALESCE(is_test, FALSE) = FALSE
                AND parent_run_id IS NULL
                AND (root_run_id IS NULL OR root_run_id = id)
                AND (created_at >= $2 OR status IN ('awaiting_approval', 'awaiting_form', 'awaiting_confirm'))
              GROUP BY automation_id`,
            [automationIds, iso(since)],
        );
        for (const row of r.rows) {
            out.set(row.automation_id, {
                runs: Number(row.runs) || 0,
                failures: Number(row.failures) || 0,
                waiting: Number(row.waiting) || 0,
            });
        }
        return out;
    }

    /** The routine's most recent notification attempts, newest first. */
    async function listRecentNotificationEvents(automationId, { limit = 20 } = {}) {
        await ready();
        const r = await db.query(
            `SELECT * FROM automation_notification_events
              WHERE automation_id = $1
              ORDER BY created_at DESC
              LIMIT $2`,
            [automationId, Math.max(1, Math.min(100, Number(limit) || 20))],
        );
        return r.rows.map(rowToEvent);
    }

    /** Drop rows older than `days` (the ledger is operational, not history). */
    async function purgeNotificationEvents({ days = 30 } = {}) {
        await ready();
        const r = await db.query(
            `DELETE FROM automation_notification_events
              WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
            [Math.max(1, Number(days) || 30)],
        );
        return r.rowCount ?? 0;
    }

    return {
        recordNotificationEvents,
        countRecentMessages,
        listPendingBundles,
        markEventsReported,
        listHeldForDigest,
        lastDigestAt,
        listDigestAutomations,
        digestRunStats,
        listRecentNotificationEvents,
        purgeNotificationEvents,
    };
}

// The instance the app uses: the pool, behind the store's schema init.
function defaultStore() {
    const { initDB, pool } = require('./core');
    return makeNotificationEventsStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });
}

let _default = null;
function instance() {
    if (!_default) _default = defaultStore();
    return _default;
}

const lazy = (name) => (...args) => instance()[name](...args);

module.exports = {
    makeNotificationEventsStore,
    rowToEvent,
    recordNotificationEvents: lazy('recordNotificationEvents'),
    countRecentMessages: lazy('countRecentMessages'),
    listPendingBundles: lazy('listPendingBundles'),
    markEventsReported: lazy('markEventsReported'),
    listHeldForDigest: lazy('listHeldForDigest'),
    lastDigestAt: lazy('lastDigestAt'),
    listDigestAutomations: lazy('listDigestAutomations'),
    digestRunStats: lazy('digestRunStats'),
    listRecentNotificationEvents: lazy('listRecentNotificationEvents'),
    purgeNotificationEvents: lazy('purgeNotificationEvents'),
};
