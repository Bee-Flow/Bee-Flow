// @typecheck
/**
 * Narrow reads: the rows behind on-disk recordings, the dedup and
 * meetings-view lookups by source, Talk room and Meet code, and the
 * "previously in this series" card. Only that card reads a content column
 * (`summary`), and it opens it through transcriptCrypto like every other
 * content read.
 *
 * transcriptCrypto is required here directly, not handed in by the barrel the
 * way reads.js gets it: it sits in no import cycle
 * (`node scripts/scc-ratchet.mjs server --list`), and lint:scc-ratchet would
 * fail if this edge closed one again.
 */

const { getOne, getAll } = require('../../db');
const log = require('../../telemetry/log');
const transcriptCrypto = require('../transcriptCrypto');
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
 * The SQL for a series lookup (Talk room token or Meet code): owner-scoped
 * when a user is given, and limited to ONE occurrence when `since` is.
 *
 * A room token and a Meet code belong to the whole series: a weekly stand-up
 * keeps them every week. Matched on that alone, week 2 found week 1's note,
 * so the meetings views showed every later occurrence as "Note created"
 * (linked to the old note) and hid its Transcribe button. A note is made after
 * its meeting starts, so `since` (the occurrence's start) rules out the notes
 * of earlier occurrences; the oldest note from then on is this occurrence's.
 * Without `since` it stays "the newest note of the series".
 * @param {'talk_room_token' | 'meet_meeting_code'} column
 * @param {string} value
 * @param {string | null} userId
 * @param {string | Date | null | undefined} since
 */
function seriesLookup(column, value, userId, since) {
    /** @type {string[]} */
    const params = [value];
    const where = [`${column} = $1`];
    if (userId) {
        params.push(userId);
        where.push(`user_id = $${params.length}`);
    }
    const sinceDate = since ? new Date(since) : null;
    const scoped = !!sinceDate && !Number.isNaN(sinceDate.getTime());
    if (scoped) {
        params.push(/** @type {Date} */ (sinceDate).toISOString());
        where.push(`created_at >= $${params.length}::timestamptz`);
    }
    return getOne(
        `SELECT id, user_id, title, created_at FROM transcriptions WHERE ${where.join(' AND ')} ORDER BY created_at ${scoped ? 'ASC' : 'DESC'} LIMIT 1`,
        params,
    );
}

/**
 * The transcription created from a given Talk room token (used by the
 * "Upcoming meetings" view to show a "recorded → note" status). Scoped to the
 * owner so the meetings view only reflects the current user's notes. Pass
 * `since` (the occurrence's start) to get that occurrence's note; see
 * seriesLookup.
 * @param {string | null | undefined} talkRoomToken
 * @param {string | null} [userId]
 * @param {{ since?: string | Date | null }} [opts]
 */
async function getTranscriptionByTalkRoomToken(talkRoomToken, userId = null, { since = null } = {}) {
    if (!talkRoomToken) return null;
    await initDB();
    return seriesLookup('talk_room_token', talkRoomToken, userId, since);
}

/**
 * The transcription created from a given Google Meet meeting code.
 * Mirrors getTranscriptionByTalkRoomToken — owner-scoped so the meetings view
 * only reflects the current user's notes, and `since` for one occurrence.
 * @param {string | null | undefined} meetingCode
 * @param {string | null} [userId]
 * @param {{ since?: string | Date | null }} [opts]
 */
async function getTranscriptionByMeetMeetingCode(meetingCode, userId = null, { since = null } = {}) {
    if (!meetingCode) return null;
    await initDB();
    return seriesLookup('meet_meeting_code', meetingCode, userId, since);
}

/**
 * The summary of a series row, opened. `summary` is sealed whenever the
 * note's organisation encrypts transcripts, and the key is that row's own
 * organisation's (a series row may be published from another org the reader
 * belongs to). Returned raw, the card showed the head of the ciphertext
 * envelope. A row that will not open gives '' rather than failing the card:
 * the note itself still throws when opened, which is where that belongs.
 * @param {{ id: string, organization_id?: string | null, summary?: string | null }} r
 * @returns {Promise<string>}
 */
async function openSummary(r) {
    if (!r.summary) return '';
    try {
        const ctx = r.organization_id
            ? await transcriptCrypto.resolveTranscriptCrypto(r.organization_id)
            : transcriptCrypto.PLAINTEXT_CONTEXT;
        const opened = transcriptCrypto.decryptRow({ id: r.id, summary: r.summary }, ctx);
        return typeof opened.summary === 'string' ? opened.summary : '';
    } catch (e) {
        log.warn(`[TranscriptionStore] Series summary of '${r.id}' could not be opened: ${/** @type {Error} */ (e).message}`);
        return '';
    }
}

/**
 * The most recent earlier note in the same recurring series (same Google Meet
 * code or Talk room), under the caller's normal read ACL — powers the
 * "previously in this series" card. Light shape: no segments/transcript.
 * @param {{ meetMeetingCode?: string | null, talkRoomToken?: string | null, beforeCreatedAt: unknown, excludeId: string, userId: string, orgIds?: string[] | null, userGroupIds?: string[], isSuperAdmin?: boolean }} q
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
        `SELECT id, organization_id, title, created_at, summary, action_items
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
        summary: await openSummary(r),
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
