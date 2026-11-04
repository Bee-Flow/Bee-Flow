// @typecheck strict
/**
 * What an ingest reads about the note's owner (core/meetingNotes/ingestRecordingCore.js):
 * the first name that anchors speaker naming, and the default summary template.
 */

const { fallback } = require('../../utils/bestEffort');

/** @param {string} userId */
async function resolveUserFirstName(userId) {
    try {
        const { getUser } = require('../../stores/userStore');
        const u = await getUser(userId);
        return u?.firstName || u?.displayName || null;
    } catch (_) { return null; }
}

/**
 * Resolve the note owner's default summary TEMPLATE (personal ▸ group ▸ org) so
 * a saved default also styles auto-ingested (Talk / Meet) notes.
 * Best-effort: returns null (→ built-in first-generation prompt) on any failure.
 *
 * The whole row, because the note is stamped with it (which template, which
 * version): no id can be recovered from a prompt string. null stamps
 * nothing: the built-in first-generation prompt is none of the five built-in
 * templates, so there is nothing true to report.
 * @param {string} userId
 * @param {string | null | undefined} orgId
 */
async function resolveOwnerDefaultTemplate(userId, orgId) {
    try {
        const { getUser } = require('../../stores/userStore');
        const summaryTemplateStore = require('../../stores/summaryTemplateStore');
        const u = await getUser(userId);
        /** @type {string[]} */
        let groupIds = [];
        if (u) {
            if (Array.isArray(u.groups)) groupIds = u.groups;
            else { try { groupIds = JSON.parse(u.groups || '[]'); } catch (err) { fallback('core/meetingNotes/ingestOwnerDefaults:resolveOwnerDefaultTemplate', err); /* ignore */ } }
        }
        return await summaryTemplateStore.resolveDefaultTemplate({ userId, orgIds: orgId ? [orgId] : [], groupIds });
    } catch (_) {
        return null;
    }
}

module.exports = { resolveUserFirstName, resolveOwnerDefaultTemplate };
