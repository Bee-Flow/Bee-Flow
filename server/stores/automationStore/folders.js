// @typecheck
/**
 * folders.js — the org-wide grouping for the automations sidebar.
 *
 * One flat level, deliberately. Nesting buys a tree UI, cycle checks and a
 * "what happens to the children" question at every move; twenty automations in
 * named folders needs none of that.
 *
 * The invariant that matters: **deleting a folder never deletes automations.**
 * Folders are shared across the organisation, so one can easily hold automations
 * belonging to colleagues the deleting user cannot even see — `getAutomationsForUser`
 * filters on `user_id` alone. Detaching is the only safe reading of "remove
 * this folder", and it is what `deleteFolder` does.
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll } = require('./core');
const { buildUpdate } = require('../lib/sqlBuilder');

const MAX_NAME_LEN = 80;

function rowToFolder(r) {
    if (!r) return null;
    return {
        id: r.id,
        organizationId: r.organization_id ?? null,
        name: r.name,
        icon: r.icon || '📁',
        color: r.color ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        // Only present when the caller asked for counts.
        ...(r.automation_count !== undefined ? { automationCount: Number(r.automation_count || 0) } : {}),
    };
}

function cleanName(name) {
    return String(name || '').trim().slice(0, MAX_NAME_LEN);
}

/**
 * Folders for an org, each with how many of THIS user's automations sit in it.
 * The count is per-user on purpose: the list beside it is per-user too, so a
 * folder claiming "7" next to three visible rows would just look broken.
 */
async function listFolders(organizationId, userId) {
    await initDB();
    const rows = await getAll(
        `SELECT f.*, (
             SELECT COUNT(*) FROM automations a
              WHERE a.folder_id = f.id AND a.user_id = $2 AND a.kind = 'automation' AND a.deleted_at IS NULL
         ) AS automation_count
           FROM automation_folders f
          WHERE f.organization_id IS NOT DISTINCT FROM $1
          ORDER BY LOWER(f.name) ASC`,
        [organizationId ?? null, userId],
    );
    return rows.map(rowToFolder);
}

async function getFolder(id) {
    await initDB();
    return rowToFolder(await getOne(`SELECT * FROM automation_folders WHERE id = $1`, [id]));
}

async function createFolder({ organizationId = null, name, icon = null, color = null }) {
    await initDB();
    const clean = cleanName(name);
    if (!clean) throw new Error('A folder needs a name.');
    const id = crypto.randomBytes(12).toString('hex');
    await run(
        `INSERT INTO automation_folders (id, organization_id, name, icon, color)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, organizationId ?? null, clean, icon || '📁', color ?? null],
    );
    return getFolder(id);
}

const FOLDER_COLUMNS = {
    name: { col: 'name', transform: (v) => cleanName(v) },
    icon: { col: 'icon', transform: (v) => v || '📁' },
    color: { col: 'color', transform: (v) => v ?? null },
};

/**
 * @param id
 * @param {{ name?: string, icon?: string, color?: string }} [opts]
 */
async function updateFolder(id, { name, icon, color } = {}) {
    await initDB();
    // Rejected BEFORE the builder runs: a rename to whitespace is a caller
    // error, not an empty patch that silently keeps the old name.
    if (name !== undefined && !cleanName(name)) throw new Error('A folder needs a name.');
    const built = buildUpdate({
        table: 'automation_folders',
        updates: { name, icon, color },
        columnMap: FOLDER_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }],
    });
    if (!built) return getFolder(id);
    await run(built.sql, built.params);
    return getFolder(id);
}

/**
 * Remove the folder and turn its automations loose. Never deletes an
 * automation — see the header. Returns how many were detached so the caller
 * can say so.
 */
async function deleteFolder(id) {
    await initDB();
    const { rowCount } = await run(`UPDATE automations SET folder_id = NULL WHERE folder_id = $1`, [id]);
    await run(`DELETE FROM automation_folders WHERE id = $1`, [id]);
    return { detached: rowCount || 0 };
}

module.exports = {
    listFolders,
    getFolder,
    createFolder,
    updateFolder,
    deleteFolder,
    MAX_FOLDER_NAME_LEN: MAX_NAME_LEN,
};
