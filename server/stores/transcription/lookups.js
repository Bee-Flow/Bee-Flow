// @typecheck
/**
 * Narrow reads that never touch content columns: the rows behind on-disk
 * recordings, the dedup and meetings-view lookups by source, Talk room and
 * Meet code, and the "previously in this series" card.
 */

const { getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJsonArray } = require('./jsonArrays');

/**
 * Lookup a transcription by its canonical source URI. Used as the cheap
 * pre-check before downloading + transcribing a Nextcloud/Talk recording so
 * the same file isn't processed twice.
 */
/**
 * Rows for a set of on-disk recordings, keyed by their absolute `audio_path`.
 *
 * The repair sweep is disk-first on purpose: on a multi-replica deploy a note's
 * local file exists only on the pod that created it, so asking the DB "which
 * notes lack a durable copy" returns mostly rows this pod cannot help with.
 * Listing the directory and asking about THOSE files is bounded and always
 * actionable. Exact-match is safe because the container path is identical on
 * every pod.
 */
async function getTranscriptionsByAudioPaths(paths) {
    const list = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && p);
    if (!list.length) return [];
    await initDB();
    return getAll(
        `SELECT id, user_id, audio_path, audio_storage_key, file_name
           FROM transcriptions
          WHERE audio_path = ANY($1::text[])`,
        [list]
    );
}

async function getTranscriptionBySourceUri(sourceUri) {
    if (!sourceUri) return null;
    await initDB();
    return getOne('SELECT id, user_id, organization_id, title FROM transcriptions WHERE source_uri = $1', [sourceUri]);
}

/**
 * Most recent transcription created from a given Talk room token (used by the
 * "Upcoming meetings" view to show a "recorded → note" status). Scoped to the
 * owner so the meetings view only reflects the current user's notes.
 */
async function getTranscriptionByTalkRoomToken(talkRoomToken, userId = null) {
    if (!talkRoomToken) return null;
    await initDB();
    if (userId) {
        return getOne(
            'SELECT id, user_id, title, created_at FROM transcriptions WHERE talk_room_token = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1',
            [talkRoomToken, userId],
        );
    }
    return getOne(
        'SELECT id, user_id, title, created_at FROM transcriptions WHERE talk_room_token = $1 ORDER BY created_at DESC LIMIT 1',
        [talkRoomToken],
    );
}

/**
 * Most recent transcription created from a given Google Meet meeting code.
 * Mirrors getTranscriptionByTalkRoomToken — owner-scoped so the meetings view
 * only reflects the current user's notes.
 */
async function getTranscriptionByMeetMeetingCode(meetingCode, userId = null) {
    if (!meetingCode) return null;
    await initDB();
    if (userId) {
        return getOne(
            'SELECT id, user_id, title, created_at FROM transcriptions WHERE meet_meeting_code = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1',
            [meetingCode, userId],
        );
    }
    return getOne(
        'SELECT id, user_id, title, created_at FROM transcriptions WHERE meet_meeting_code = $1 ORDER BY created_at DESC LIMIT 1',
        [meetingCode],
    );
}

/**
 * The most recent earlier note in the same recurring series (same Google Meet
 * code or Talk room), under the caller's normal read ACL — powers the
 * "previously in this series" card. Light shape: no segments/transcript.
 */
async function getSeriesPrevious({ meetMeetingCode = null, talkRoomToken = null, beforeCreatedAt, excludeId, userId, orgIds = [], userGroupIds = [], isSuperAdmin = false }) {
    await initDB();
    if (!meetMeetingCode && !talkRoomToken) return null;

    const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const seriesClause = meetMeetingCode
        ? `meet_meeting_code = ${p(meetMeetingCode)}`
        : `talk_room_token = ${p(talkRoomToken)}`;
    const beforeClause = `created_at < ${p(beforeCreatedAt)}`;
    const excludeClause = `id <> ${p(excludeId)}`;

    // Same ACL as getTranscription: owner, legacy share, or org-published.
    let aclClause = 'TRUE';
    if (!isSuperAdmin) {
        const clauses = [`user_id = ${p(userId)}`, `shared_with @> ${p(JSON.stringify([userId]))}::jsonb`];
        if (Array.isArray(orgIds) && orgIds.length > 0) {
            if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
                clauses.push(`(is_published = true AND organization_id = ANY(${p(orgIds)}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| ${p(userGroupIds)}::text[]))`);
            } else {
                clauses.push(`(is_published = true AND organization_id = ANY(${p(orgIds)}::text[]) AND shared_groups = '[]'::jsonb)`);
            }
        }
        aclClause = `(${clauses.join(' OR ')})`;
    }

    const r = await getOne(
        `SELECT id, title, created_at, summary, action_items
         FROM transcriptions
         WHERE ${seriesClause} AND status = 'completed' AND ${beforeClause} AND ${excludeClause} AND ${aclClause}
         ORDER BY created_at DESC LIMIT 1`,
        params
    );
    if (!r) return null;
    const actionItems = parseJsonArray(r.action_items);
    return {
        id: r.id,
        title: r.title,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        summary: r.summary || '',
        openActionItems: actionItems.filter((a) => a && !a.done),
    };
}

module.exports = {
    getTranscriptionsByAudioPaths,
    getTranscriptionBySourceUri,
    getTranscriptionByTalkRoomToken,
    getTranscriptionByMeetMeetingCode,
    getSeriesPrevious,
};
