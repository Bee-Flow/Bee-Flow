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

/**
 * Meeting notes: through the store, which also removes the recording (the
 * local file and the durable object).
 * @param {string} userId
 */
async function eraseTranscriptions(userId) {
    const rows = await getAll('SELECT id FROM transcriptions WHERE user_id = $1', [userId]);
    const { deleteTranscription } = require('../stores/transcriptionStore');
    for (const r of rows) await deleteTranscription(r.id, userId);
    return rows.length;
}

/**
 * The organisation's remaining meeting notes (members removed by another
 * path), for the organisation cascade.
 * @param {string} orgId
 */
async function eraseOrgTranscriptions(orgId) {
    const rows = await getAll('SELECT id, user_id FROM transcriptions WHERE organization_id = $1', [orgId]);
    const { deleteTranscription } = require('../stores/transcriptionStore');
    for (const r of rows) await deleteTranscription(r.id, r.user_id);
    return rows.length;
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

module.exports = { eraseTranscriptions, eraseOrgTranscriptions, eraseWebpages, eraseStudioApps, eraseSkills, eraseStoragePrefix };
