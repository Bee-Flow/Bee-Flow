// @typecheck
/**
 * Who wants to hear about what: per-user notification preferences (channel x
 * event) and per-user project mutes. Only rows that differ from the defaults
 * need to exist; `getPrefs` merges the stored rows over DEFAULTS.
 *
 * Built by a factory over a `{ query }` handle so the pg test runs the
 * store's own SQL against PGlite; the default instance wraps the pool.
 */

'use strict';

const { exec, pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const EVENTS = Object.freeze(['chat_mention', 'comment_mention', 'added', 'role_changed', 'removed', 'left', 'owner_changed', 'task_assigned']);
const CHANNELS = Object.freeze(['bell', 'email']);
const EMAIL_OFF = new Set(['role_changed', 'removed', 'left']);
const DEFAULTS = Object.freeze({
    bell: Object.freeze(Object.fromEntries(EVENTS.map((e) => [e, true]))),
    email: Object.freeze(Object.fromEntries(EVENTS.map((e) => [e, !EMAIL_OFF.has(e)]))),
});

const DDL = `
CREATE TABLE IF NOT EXISTS user_notification_prefs (
    user_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    event TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    PRIMARY KEY (user_id, channel, event)
);
CREATE TABLE IF NOT EXISTS project_notification_mutes (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, project_id)
);
`;

/**
 * @param {{ query: Function }} db
 * @param {{ ready?: () => Promise<any> }} [opts]
 */
function makeNotificationPrefsStore(db, { ready = async () => {} } = {}) {
    /** @param {string} userId @returns {Promise<{bell: Record<string, boolean>, email: Record<string, boolean>}>} */
    async function getPrefs(userId) {
        await ready();
        /** @type {Record<string, Record<string, boolean>>} */
        const prefs = { bell: { ...DEFAULTS.bell }, email: { ...DEFAULTS.email } };
        const { rows } = await db.query('SELECT channel, event, enabled FROM user_notification_prefs WHERE user_id = $1', [userId]);
        for (const r of rows) {
            if (prefs[r.channel] && r.event in prefs[r.channel]) prefs[r.channel][r.event] = r.enabled === true;
        }
        return { bell: prefs.bell, email: prefs.email };
    }

    /** @param {string} userId @param {Record<string, Record<string, boolean>>} partial */
    async function setPrefs(userId, partial) {
        const entries = [];
        for (const [channel, events] of Object.entries(partial || {})) {
            if (!CHANNELS.includes(channel)) throw new TypeError(`unknown channel: ${channel}`);
            for (const [event, enabled] of Object.entries(events || {})) {
                if (!EVENTS.includes(event)) throw new TypeError(`unknown event: ${event}`);
                if (typeof enabled !== 'boolean') throw new TypeError(`${channel}.${event} must be a boolean`);
                entries.push([channel, event, enabled]);
            }
        }
        await ready();
        for (const [channel, event, enabled] of entries) {
            await db.query(
                `INSERT INTO user_notification_prefs (user_id, channel, event, enabled) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, channel, event) DO UPDATE SET enabled = EXCLUDED.enabled`,
                [userId, channel, event, enabled],
            );
        }
    }

    /** @param {string} userId @param {string} projectId */
    async function isMuted(userId, projectId) {
        await ready();
        const r = await db.query('SELECT 1 FROM project_notification_mutes WHERE user_id = $1 AND project_id = $2', [userId, projectId]);
        return r.rows.length > 0;
    }

    /** @param {string} userId @param {string} projectId @param {boolean} muted */
    async function setMuted(userId, projectId, muted) {
        await ready();
        if (muted) {
            await db.query(
                'INSERT INTO project_notification_mutes (user_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [userId, projectId],
            );
        } else {
            await db.query('DELETE FROM project_notification_mutes WHERE user_id = $1 AND project_id = $2', [userId, projectId]);
        }
    }

    /**
     * The ids whose prefs allow each channel for `event` and who have not muted the project.
     * @param {string[]} userIds @param {string} projectId @param {string} event
     * @returns {Promise<{bell: string[], email: string[]}>}
     */
    async function filterRecipients(userIds, projectId, event) {
        if (!EVENTS.includes(event)) throw new TypeError(`unknown event: ${event}`);
        const ids = [...new Set(userIds || [])];
        /** @type {{bell: string[], email: string[]}} */
        const out = { bell: [], email: [] };
        if (!ids.length) return out;
        await ready();
        const muted = new Set((await db.query(
            'SELECT user_id FROM project_notification_mutes WHERE project_id = $1 AND user_id = ANY($2::text[])', [projectId, ids],
        )).rows.map((/** @type {{user_id: string}} */ r) => r.user_id));
        const stored = (await db.query(
            'SELECT user_id, channel, enabled FROM user_notification_prefs WHERE event = $1 AND user_id = ANY($2::text[])', [event, ids],
        )).rows;
        const override = new Map(stored.map((/** @type {{user_id: string, channel: string, enabled: boolean}} */ r) => [`${r.user_id}|${r.channel}`, r.enabled === true]));
        for (const id of ids) {
            if (muted.has(id)) continue;
            for (const ch of CHANNELS) {
                const v = override.has(`${id}|${ch}`) ? override.get(`${id}|${ch}`) : DEFAULTS[ch][event];
                if (v) out[ch].push(id);
            }
        }
        return out;
    }

    return { getPrefs, setPrefs, isMuted, setMuted, filterRecipients };
}

const initDB = makeStoreInit('NotificationPrefsStore', async () => {
    await exec(DDL);
    log.info('[NotificationPrefsStore] PostgreSQL initialized');
});

const defaultStore = makeNotificationPrefsStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });

module.exports = { initDB, DDL, EVENTS, CHANNELS, DEFAULTS, makeNotificationPrefsStore, ...defaultStore };
