// @typecheck strict
/**
 * Explicit "record" marks as a signal for background import engines: which
 * users have a live opt-in. Split from meetingPrefsStore.js (file budget).
 *
 * A mark counts while it is live: a series mark (id_kind 'code') always, an
 * event mark only OPT_IN_EVENT_DAYS days after it was set (the meeting is over
 * by then), so a stale mark does not keep a user polled forever. Only personal
 * rows count; an org-wide TRUE is not one person's choice.
 */

'use strict';

/**
 * Collaborators, loaded on first use; tests swap them through init().
 * @type {{ getAll: Function, prefs: { PROVIDERS: string[], initDB: () => Promise<any> } } | null}
 */
let injected = null;
/** @param {{ getAll: Function, prefs: { PROVIDERS: string[], initDB: () => Promise<any> } }} deps */
function init(deps) { injected = deps; }
function deps() {
    return injected || { getAll: require('../db').getAll, prefs: require('./meetingPrefsStore') };
}

const OPT_IN_EVENT_DAYS = 10;

/**
 * Does this list (as returned by loadMeetingPrefs().rows) hold a live,
 * personal record=true mark? Pure; same rule as the SQL below.
 * @param {Array<{userId?: string|null, idKind?: string, record?: boolean|null, updatedAt?: string|null}>} rows
 */
function hasLiveRecordOptIn(rows) {
    const floor = Date.now() - OPT_IN_EVENT_DAYS * 86400_000;
    return (Array.isArray(rows) ? rows : []).some(r => r && r.userId && r.record === true
        && (r.idKind === 'code' || (!!r.updatedAt && new Date(r.updatedAt).getTime() > floor)));
}

/**
 * Users with at least one live personal record=true row for this provider.
 * @param {{ provider?: string }} [opts]
 * @returns {Promise<string[]>}
 */
async function listUsersWithRecordOptIn({ provider } = {}) {
    const { getAll, prefs } = deps();
    if (!provider || !prefs.PROVIDERS.includes(provider)) return [];
    await prefs.initDB();
    const rows = await getAll(
        `SELECT DISTINCT user_id FROM meeting_prefs WHERE provider = $1 AND user_id <> '' AND record = TRUE
            AND (id_kind = 'code' OR updated_at > NOW() - INTERVAL '${OPT_IN_EVENT_DAYS} days')`,
        [provider],
    );
    return (rows || []).map(/** @param {{ user_id?: string }} r */ r => r.user_id).filter(Boolean);
}

module.exports = { init, OPT_IN_EVENT_DAYS, hasLiveRecordOptIn, listUsersWithRecordOptIn };
