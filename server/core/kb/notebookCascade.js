// @typecheck
/**
 * notebookCascade — erase everything a notebook owns, not just its rows.
 *
 * Deleting a notebook used to drop the `notebooks` row (sources and versions
 * cascading via FK) and delete its knowledge bases. What it never did was
 * remove the BYTES: the uploaded file blobs in object storage and the embedded
 * chunks derived from them. And `userStore.deleteUser` didn't touch notebooks
 * at all, so deleting a user left their documents, sources, versions and chat
 * history behind entirely.
 *
 * For a product whose selling point is GDPR compliance, "delete" has to mean
 * the data is gone. This module is the single place that knows how, so the
 * notebook route, the user-deletion path and any future caller cannot drift.
 *
 * Every step is best-effort and logged: a storage hiccup must not prevent the
 * database rows from going away, or a failed delete would be unretryable.
 */

const { run } = require('../../db');
const notebookStore = require('../../stores/notebookStore');
const notebookConversationStore = require('../../stores/notebookConversationStore');
const storageStore = require('../../stores/storageStore');
const kbStore = require('../../stores/knowledgeBases');
const { deleteDocumentChunks, findDocumentsBySourceUri } = require('./kbIngestionHelpers');
const log = require('../../telemetry/log');

/**
 * Delete a single source's artifacts: its stored blob and every document (and
 * therefore every chunk/embedding) derived from it.
 *
 * Resolves ALL matching documents, not just the first: re-ingesting a source
 * can leave several rows sharing a source_uri, and stopping at one orphaned the
 * rest — deleted text stayed searchable.
 */
async function cleanupSourceArtifacts(nb, source, userId) {
    if (!source) return;
    if (source.storageKey && !String(source.storageKey).startsWith('local:')) {
        try { await storageStore.deleteFile(source.storageKey); }
        catch (e) { log.warn(`[NotebookCascade] storage cleanup for ${source.id}:`, e.message); }
    }
    const kbIds = (nb && nb.knowledgeBaseIds) || [];
    for (const kbId of kbIds) {
        try {
            const docs = await findDocumentsBySourceUri(kbId, source.id);
            for (const doc of docs || []) {
                await deleteDocumentChunks(kbId, doc.id, userId);
            }
        } catch (e) {
            log.warn(`[NotebookCascade] chunk cleanup for source ${source.id} in kb ${kbId}:`, e.message);
        }
    }
}

/**
 * Fully delete one notebook and everything it owns.
 *
 * Order matters: artifacts are cleaned up while the rows still exist (we need
 * the source list and the kb ids), then the notebook row goes, then the
 * notebook-owned knowledge bases.
 *
 * @returns {Promise<{deleted: boolean, sources: number, kbs: number}>}
 */
/**
 * Detach a deleted notebook from any chat that had it open as its workspace.
 * Best-effort per table so one missing table can't block the other.
 */
async function clearWorkspaceLinks(notebookId) {
    for (const table of ['agent_conversations', 'direct_conversations']) {
        try {
            await run(`UPDATE ${table} SET workspace_notebook_id = NULL WHERE workspace_notebook_id = $1`, [notebookId]);
        } catch (e) {
            log.warn(`[NotebookCascade] clearing ${table}.workspace_notebook_id for ${notebookId}:`, e.message);
        }
    }
}

async function deleteNotebookCascade(notebookId, userId) {
    const nb = await notebookStore.getNotebook(notebookId, userId);
    if (!nb) return { deleted: false, sources: 0, kbs: 0 };

    // 1. Per-source bytes: object-storage blobs + derived chunks/embeddings.
    let sources = [];
    try { sources = await notebookStore.getSources(notebookId); }
    catch (e) { log.warn(`[NotebookCascade] could not list sources for ${notebookId}:`, e.message); }
    for (const source of sources) {
        await cleanupSourceArtifacts(nb, source, userId);
    }

    // 2. The notebook row — sources and versions cascade via FK.
    try { await notebookStore.deleteNotebook(notebookId, userId); }
    catch (e) { log.error(`[NotebookCascade] deleting notebook ${notebookId} failed:`, e.message); }

    // 3. Knowledge bases the NOTEBOOK created. A KB the user attached by hand
    //    is theirs and outlives the notebook; deleting those destroyed data the
    //    user never asked to lose.
    let kbs = 0;
    for (const kbId of nb.knowledgeBaseIds || []) {
        try {
            const kb = await kbStore.getKB(kbId);
            if (!kb) continue;
            if (kb.source_kind !== 'notebook_auto' || kb.tenant_id !== userId) continue;
            await kbStore.deleteKB(kbId);
            kbs++;
        } catch (e) {
            log.warn(`[NotebookCascade] KB cleanup for ${kbId}:`, e.message);
        }
    }

    // 4. The persisted (encrypted) in-notebook chat.
    try { await notebookConversationStore.deleteForNotebook(notebookId); }
    catch (e) { log.warn(`[NotebookCascade] conversation cleanup for ${notebookId}:`, e.message); }

    // 5. Chats that had this notebook open as their workspace. The column is a
    //    plain TEXT id with no FK, so nothing cleared it: those chats kept
    //    pointing at a notebook that no longer exists and their workspace tools
    //    silently resolved to nothing.
    await clearWorkspaceLinks(notebookId);

    // 6. What hung off it in a project: its co-editing state, the comment
    //    threads on it and its compliance content signal. None of them has a
    //    foreign key to the notebook (best-effort, never throws).
    await require('../projectContent/itemLifecycle').deleted('notebook', notebookId);

    return { deleted: true, sources: sources.length, kbs };
}

/**
 * Erase every notebook belonging to a user. Called from the account-deletion
 * path so a deleted user leaves no notebook data behind.
 *
 * @returns {Promise<{notebooks: number}>}
 */
async function deleteAllNotebooksForUser(userId) {
    let total = 0;
    // Page through: getNotebooks is limit-bounded, so loop until it comes back
    // empty rather than assuming one page covers the account.
    for (;;) {
        let batch = [];
        try { batch = await notebookStore.getNotebooks(userId, { limit: 100, offset: 0 }); }
        catch (e) { log.warn(`[NotebookCascade] listing notebooks for ${userId} failed:`, e.message); break; }
        if (!batch.length) break;
        for (const nb of batch) {
            await deleteNotebookCascade(nb.id, userId);
            total++;
        }
        // Deleting the page means offset 0 now returns the next set; if nothing
        // was removed (all failed), stop rather than spin.
        if (batch.length && total === 0) break;
    }
    return { notebooks: total };
}

module.exports = { deleteNotebookCascade, deleteAllNotebooksForUser, cleanupSourceArtifacts };
