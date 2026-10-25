// @typecheck noImplicitAny
/**
 * automation_caller_notices: which people have acknowledged the one-time notice
 * that an automation runs with THEIR OWN connections (runPolicy.connections =
 * 'caller'), and WHAT they acknowledged: the list of apps and owner-controlled
 * destinations it named, so the notice shows again when the automation grows
 * one. The table comes from migrations/automation-caller-connections-2026-10.js;
 * the routes prove the person may run the automation before they read or write
 * a row here.
 */

'use strict';

const { initDB, run, getOne } = require('./core');

/**
 * The acknowledged items, or null when this person never acknowledged the notice.
 * @param {string} userId
 * @param {string} automationId
 */
async function getCallerNoticeAck(userId, automationId) {
    if (!userId || !automationId) return null;
    await initDB();
    const row = await getOne(
        'SELECT items FROM automation_caller_notices WHERE user_id = $1 AND automation_id = $2',
        [userId, automationId],
    );
    if (!row) return null;
    try {
        const parsed = JSON.parse(row.items);
        return Array.isArray(parsed) ? parsed.filter((i) => typeof i === 'string') : [];
    } catch (_) { return []; }
}

/**
 * Remember that this person acknowledged exactly these items (replaces an earlier, smaller set).
 * @param {string} userId
 * @param {string} automationId
 * @param {string[]} [items]
 */
async function markCallerNoticeSeen(userId, automationId, items = []) {
    if (!userId || !automationId) return;
    await initDB();
    await run(
        `INSERT INTO automation_caller_notices (user_id, automation_id, items) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, automation_id) DO UPDATE SET items = EXCLUDED.items, seen_at = NOW()`,
        [userId, automationId, JSON.stringify([...new Set(items)].sort())],
    );
}

module.exports = { getCallerNoticeAck, markCallerNoticeSeen };
