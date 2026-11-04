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

/**
 * Meeting notes: through the store, which also removes the recording (the
 * local file and the durable object).
 * @param {string} userId
 */
async function eraseTranscriptions(userId) {
    const rows = await getAll('SELECT id, tags FROM transcriptions WHERE user_id = $1', [userId]);
    const { deleteTranscription } = require('../stores/transcriptionStore');
    for (const r of rows) await deleteTranscription(r.id, userId);
    await rearmMeetingSourcesFor(rows);
    return rows.length;
}

/**
 * The organisation's remaining meeting notes (members removed by another
 * path), for the organisation cascade.
 * @param {string} orgId
 */
async function eraseOrgTranscriptions(orgId) {
    const rows = await getAll('SELECT id, user_id, tags FROM transcriptions WHERE organization_id = $1', [orgId]);
    const { deleteTranscription } = require('../stores/transcriptionStore');
    for (const r of rows) await deleteTranscription(r.id, r.user_id);
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
        await require('../stores/kbSources').armMeetingSourcesForRemoval(tags);
    } catch (err) {
        require('../utils/bestEffort').bestEffort('projects/accountContentErasure:rearmMeetingSources', err);
    }
}

/**
 * Web pages: the objects under the page's prefix (scripts, versions, extra
 * files, the page database) and then the row; versions, sources, extra-file
 * and public-share rows cascade on the FK. A plain DELETE rather than
 * deleteWebpage: that one refuses a page filed into a Solution stage
 * (retired by a deploy, never deleted), and an account erasure is not a deploy.
 * @param {string} userId
 */
async function eraseWebpages(userId) {
    const rows = await getAll('SELECT id FROM webpages WHERE user_id = $1', [userId]);
    const webpageStore = require('../stores/webpageStore');
    const { run } = require('../db');
    for (const r of rows) {
        await webpageStore.purgeWebpageObjects(userId, r.id);
        await run('DELETE FROM webpages WHERE id = $1 AND user_id = $2', [r.id, userId]);
    }
    return rows.length;
}

/**
 * App Studio apps: through the store's delete, which purges the per-app
 * database and the attachment objects before the rows.
 * @param {string} userId
 */
async function eraseStudioApps(userId) {
    const rows = await getAll('SELECT id FROM studio_apps WHERE user_id = $1', [userId]);
    const studioAppStore = require('../stores/studioAppStore');
    for (const r of rows) await studioAppStore.deleteStudioApp(r.id, userId);
    return rows.length;
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

module.exports = {
    eraseTranscriptions, eraseOrgTranscriptions, eraseWebpages, eraseStudioApps, eraseSkills, eraseStoragePrefix,
    erasePersonalKnowledgeBases, eraseOrgKnowledgeBases,
};
