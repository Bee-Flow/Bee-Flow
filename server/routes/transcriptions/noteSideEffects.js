// @typecheck strict
/**
 * What a change to a note sets off besides the write itself
 * (routes/transcriptions/noteActions.js): the knowledge sources that collect
 * meetings by tag look again when a meeting may have left them.
 */

const log = require('../../telemetry/log');
const transcriptionStore = require('../../stores/transcriptionStore');
const { resolveAccessContext } = require('./shared');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * Let the knowledge sources that collect meetings by tag look again, after a
 * change that can take a meeting OUT of them: a delete, a tag removed, a
 * share withdrawn. Every refresh mode, not only `after_meeting`: a removal is
 * not a refresh the source's owner can decline, and a manual source would
 * otherwise keep answering from the meeting indefinitely. The pass that runs
 * then drops the documents of meetings it does not see. Best-effort: the
 * change itself has happened either way.
 * @param {unknown[]} tags
 * @param {string} meetingId
 */
async function rearmMeetingSources(tags, meetingId) {
    const list = [...new Set((Array.isArray(tags) ? tags : []).filter(/** @returns {t is string} */ (t) => typeof t === 'string' && !!t.trim()))];
    if (!list.length) return;
    try {
        const kbSourcesStore = require('../../stores/kbSources');
        const arm = typeof kbSourcesStore.armMeetingSourcesForRemoval === 'function'
            ? kbSourcesStore.armMeetingSourcesForRemoval
            : kbSourcesStore.armMeetingSources;
        await arm(list);
    } catch (err) {
        bestEffort('routes/transcriptions/noteSideEffects:rearmMeetingSources', err);
        log.warn(`[Transcriptions] knowledge sources of meeting ${meetingId} not re-armed: ${/** @type {Error} */ (err).message}`);
    }
}

/**
 * The tags a note carries now, read before a write changes them. Best-effort:
 * [] when the note cannot be read.
 * @param {import('express').Request} req
 * @param {string} id
 * @param {string} userId
 * @param {boolean} wanted  false: the write does not touch the tags, nothing to read
 * @returns {Promise<string[]>}
 */
async function storedTags(req, id, userId, wanted) {
    if (!wanted) return [];
    try {
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const before = await transcriptionStore.getTranscription(id, userId, { orgIds, userGroupIds, isSuperAdmin });
        return Array.isArray(before?.tags) ? before.tags : [];
    } catch (err) {
        bestEffort('routes/transcriptions/noteSideEffects:storedTags', err);
        return [];
    }
}

/**
 * Whether a publish change narrows who can read the note: unpublished, or
 * limited to groups. That can take it out of a knowledge base a colleague
 * built over meetings shared with them.
 * @param {{ isPublished?: boolean }} before
 * @param {boolean} isPublished
 * @param {string[]} groups
 */
function narrowsReaders(before, isPublished, groups) {
    return !!before.isPublished && (!isPublished || groups.length > 0);
}

module.exports = { rearmMeetingSources, storedTags, narrowsReaders };
