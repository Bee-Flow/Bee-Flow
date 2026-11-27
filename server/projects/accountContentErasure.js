// @typecheck strict
/**
 * The content stores' side of account erasure (the `content` port of
 * stores/user/erasurePorts.js): meeting notes, web pages, App Studio apps,
 * skills and the person's object-storage prefix. Each store is asked through
 * its own delete, which is where the bytes outside Postgres are known
 * (recordings, page objects, per-app databases, attachments).
 *
 * Lives on the features' side, like projects/erasurePorts.js that registers
 * it: stores/user/ must not require these stores, or the import graph closes
 * a loop through userStore.
 */

'use strict';

const { getAll } = require('../db');
const { isMissingTable } = require('../utils/isMissingTable');
const { moduleForDataDuty } = require('../modules/firstParty/moduleData');

/**
 * A module's part of an erasure (its own file, which holds the SQL about its tables), or null when
 * neither the module nor its data is here (then its tables are not asked either). With its data
 * but not its code the erasure refuses.
 * @template {'stores/transcription/accountErasure' | 'stores/webpage/accountErasure' | 'stores/studioApp/accountErasure'} K
 * @param {string} moduleId
 * @param {K} name
 * @param {string} duty
 */
function partFor(moduleId, name, duty) {
    return moduleForDataDuty(moduleId, name, { duty, whenDataPresent: 'refuse' });
}

/**
 * Meeting notes (module meetingNotes): through the store, which also removes the recording, and
 * the knowledge sources that watch their tags are armed.
 * @param {string} userId
 */
async function eraseTranscriptions(userId) {
    const part = await partFor('meetingNotes', 'stores/transcription/accountErasure', 'erase the meeting notes of an account');
    return part ? part.eraseTranscriptions(userId) : 0;
}

/**
 * The organisation's remaining meeting notes (members removed by another
 * path), for the organisation cascade.
 * @param {string} orgId
 */
async function eraseOrgTranscriptions(orgId) {
    const part = await partFor('meetingNotes', 'stores/transcription/accountErasure', 'erase the meeting notes of an organisation');
    return part ? part.eraseOrgTranscriptions(orgId) : 0;
}

/**
 * Web pages (module webpages): the objects under each page's prefix, then the row.
 * @param {string} userId
 */
async function eraseWebpages(userId) {
    const part = await partFor('webpages', 'stores/webpage/accountErasure', 'erase the web pages of an account');
    return part ? part.eraseWebpages(userId) : 0;
}

/**
 * App Studio apps (module apps): through the store's delete.
 * @param {string} userId
 */
async function eraseStudioApps(userId) {
    const part = await partFor('apps', 'stores/studioApp/accountErasure', 'erase the App Studio apps of an account');
    return part ? part.eraseStudioApps(userId) : 0;
}

/**
 * Skills: through the store, so activations and test runs go with each one
 * and the organisation's sync is told.
 * @param {string} userId
 */
async function eraseSkills(userId) {
    const rows = await getAll('SELECT id FROM skills WHERE user_id = $1', [userId]);
    const skillStore = require('../stores/skillStore');
    for (const r of rows) await skillStore.deleteSkill(r.id, userId);
    return rows.length;
}

/**
 * Everything left under the person's object-storage prefix (chat
 * attachments, generated images, recordings, avatars): the stores above
 * remove what they know; this removes the rest. Nothing to do when no object
 * store was ever initialised (a test, an install without one); a configured
 * store that is unreachable throws, so the erasure is reported incomplete.
 * @param {string} userId
 */
async function eraseStoragePrefix(userId) {
    const storageStore = require('../stores/storageStore');
    const { mode, configured } = storageStore.getStatus();
    if (!mode && !configured) return 0;
    if (!mode) throw new Error('object storage is configured but unreachable');
    return storageStore.deletePrefix(`users/${userId}/`);
}

/**
 * Knowledge bases: the chunks in the search service and the local table go
 * first (strict, so a failure leaves the base for a retry), then the base;
 * documents cascade on the FK and deleteKB clears the derived tables. Raw
 * rows rather than the route's guard: an erasure is not a stage deploy.
 * @param {Array<{ id: string, tenant_id: string }>} rows
 */
async function eraseKnowledgeBaseRows(rows) {
    const { purgeKbChunks } = require('../core/kb/kbPurge.mts');
    const { run } = require('../db');
    for (const kb of rows) {
        await purgeKbChunks(kb, { strict: true });
        await run('DELETE FROM kb_document_versions WHERE knowledge_base_id = $1', [kb.id])
            .catch((/** @type {unknown} */ e) => { if (!isMissingTable(e)) throw e; });
        await run('DELETE FROM knowledge_bases WHERE id = $1', [kb.id]);
    }
    return rows.length;
}

/**
 * The person's personal knowledge bases (no organisation; keyed by the
 * creator). An organisation's bases stay with the organisation.
 * @param {string} userId
 */
async function erasePersonalKnowledgeBases(userId) {
    const rows = await getAll('SELECT id, tenant_id FROM knowledge_bases WHERE tenant_id = $1 AND organization_id IS NULL', [userId]);
    return eraseKnowledgeBaseRows(rows);
}

/**
 * Every knowledge base of an organisation, for the organisation cascade.
 * @param {string} orgId
 */
async function eraseOrgKnowledgeBases(orgId) {
    const rows = await getAll('SELECT id, tenant_id FROM knowledge_bases WHERE organization_id = $1', [orgId]);
    return eraseKnowledgeBaseRows(rows);
}

/**
 * The person's id in every organisation's organisation-wide Teams import
 * setting (selected members, who switched it on, who saved it last); the
 * setting itself stays with its organisation. Returns how many named them.
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function forgetTeamsAppImportMember(userId) {
    return require('../core/meetingNotes/teamsAppImport/settings.mts').forgetUserInAllAppImports(userId);
}

module.exports = {
    eraseTranscriptions, eraseOrgTranscriptions, eraseWebpages, eraseStudioApps, eraseSkills, eraseStoragePrefix,
    erasePersonalKnowledgeBases, eraseOrgKnowledgeBases, forgetTeamsAppImportMember,
};
