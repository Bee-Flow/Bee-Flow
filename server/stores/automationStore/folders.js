// @typecheck strict
/**
 * folders.js: the org-wide folder tree of the automations sidebar, as the
 * automationStore facade exposes it. The rules (no loops, one organisation, a
 * depth limit, names unique per parent) and the SQL live in folderStore.mts;
 * this file only gives it the pool.
 *
 * The invariant that matters: **deleting a folder never deletes automations
 * or sub-folders.** Folders are shared across the organisation, so one can
 * easily hold automations belonging to colleagues the deleting user cannot even
 * see (`getAutomationsForUser` filters on `user_id` alone). Deleting detaches
 * the automations and moves the sub-folders up one level.
 */

const { initDB, pool, withTransaction } = require('./core');
// Node strips the types of a .mts file on load, and require() takes an ES module.
const { makeFolderStore, MAX_FOLDER_NAME_LEN, FolderError } = require('./folderStore.mts');

const store = makeFolderStore({
    query: (sql, params) => pool.query(sql, params),
    tx: (fn) => withTransaction((client) => fn({ query: (sql, params) => client.query(sql, params) })),
}, { ready: initDB });

module.exports = {
    listFolders: store.listFolders,
    listFolderTree: store.listFolderTree,
    getFolder: store.getFolder,
    getFolderInOrg: store.getFolderInOrg,
    createFolder: store.createFolder,
    updateFolder: store.updateFolder,
    moveFolder: store.moveFolder,
    deleteFolder: store.deleteFolder,
    requireFolderForAutomation: store.requireFolderForAutomation,
    MAX_FOLDER_NAME_LEN,
    FolderError,
};

/**
 * @typedef FolderRow
 * @property {string} id
 * @property {string | null} [organization_id]
 * @property {string} name
 * @property {string | null} [icon]
 * @property {string | null} [color]
 * @property {string | Date} created_at
 * @property {string | Date} updated_at
 * @property {number | string} [automation_count]
 */
