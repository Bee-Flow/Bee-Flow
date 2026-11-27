// @typecheck strict
/**
 * The meeting notes' part of account and organisation erasure: the `content` port's
 * eraseTranscriptions / eraseOrgTranscriptions (projects/accountContentErasure.js, core) ask for
 * this file by name (moduleForDataDuty), so the SQL about this module's table lives here.
 */

'use strict';

const { getAll } = require('../../db');

/**
 * Meeting notes: through the store, which also removes the recording (the
 * local file and the durable object).
 * @param {string} userId
 */
async function eraseTranscriptions(userId) {
    const store = require('../transcriptionStore');
    const rows = await getAll('SELECT id, tags FROM transcriptions WHERE user_id = $1', [userId]);
    for (const r of rows) await store.deleteTranscription(r.id, userId);
    await rearmMeetingSourcesFor(rows);
    return rows.length;
}

/**
 * The organisation's remaining meeting notes (members removed by another
 * path), for the organisation cascade.
 * @param {string} orgId
 */
async function eraseOrgTranscriptions(orgId) {
    const store = require('../transcriptionStore');
    const rows = await getAll('SELECT id, user_id, tags FROM transcriptions WHERE organization_id = $1', [orgId]);
    for (const r of rows) await store.deleteTranscription(r.id, r.user_id);
    await rearmMeetingSourcesFor(rows);
    return rows.length;
}

/**
 * A meeting_tag source in a colleague's knowledge base holds the summaries of
 * the erased notes until its next pass: arm every source watching one of
 * their tags, so that pass comes now and drops them. Best-effort: the erasure
 * itself already happened, and a source left unarmed still catches up at its
 * own next refresh.
 * @param {Array<{ tags?: unknown }>} rows
 */
async function rearmMeetingSourcesFor(rows) {
    /** @type {string[]} */
    const tags = [...new Set(rows.flatMap((r) => (Array.isArray(r.tags) ? r.tags : []))
        .filter((t) => typeof t === 'string' && t.trim()))];
    if (!tags.length) return;
    try {
        await require('../kbSources').armMeetingSourcesForRemoval(tags);
    } catch (err) {
        require('../../utils/bestEffort').bestEffort('projects/accountContentErasure:rearmMeetingSources', err);
    }
}

module.exports = { eraseTranscriptions, eraseOrgTranscriptions };
