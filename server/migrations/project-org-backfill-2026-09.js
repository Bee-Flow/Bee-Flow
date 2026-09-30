/**
 * Migration: give every project whose owner has an organisation that
 * organisation (2026-09).
 *
 * `projects.organization_id` defaults to '', and project creation took the
 * organisation from the SESSION only. An account whose organisation comes from
 * a group has none on its session, so its projects were stored org-less. Seen
 * on dev: a project made that day could not take a colleague of the same
 * organisation ("User does not belong to this project's organisation"), and
 * nothing could be filed in it, since documentStore compares the stored column
 * with the creator's organisation.
 *
 * Creation now falls back to the account's organisation (orgScope), and
 * routes/projects.js projectOrgOf already reads an org-less project as its
 * owner's. This backfill stores that same answer, so every reader of the
 * column agrees: the owner's own organisation, else the first one a group of
 * theirs is in. A project whose owner has none stays '' on purpose (self-host
 * and single-user installs); nothing invents a tenant for it.
 *
 * A project that already holds something sealed under its project key is skipped. That key is DERIVED
 * from the stored organisation ('' maps to the install's default organisation, auth/projectEscrow
 * getProjectKey), so stamping a different one would make the team chats, comment threads, co-edited
 * documents and shared conversations written so far permanently unreadable. Such a project keeps
 * reading as its owner's organisation through projectOrgOf; it is only not stamped.
 *
 * Idempotent: only rows still org-less are touched, so a re-run is a no-op and
 * a project made before the creation fix is deployed is caught on the next boot.
 */

'use strict';

/** The organisation a project owner acts in, the rule projectOrgOf uses; null for none. */
async function ownerOrg(ownerId) {
    const { orgScope } = require('../auth/orgScope');
    const scope = await orgScope({ session: { user: { id: ownerId } } }, { strict: true });
    return scope.homeOrgId || scope.orgId || null;
}

/**
 * Tables whose rows are sealed with the project's derived key, and how to find a project's rows
 * (the same set as auth/projectEscrow SEALED_UNDER_PROJECT_KEYS, plus shared conversations).
 * Table and column names are constants of this file, never input.
 */
const SEALED_TABLES = [
    { table: 'project_chats', where: '' },
    { table: 'project_comment_threads', where: '' },
    { table: 'collab_docs', where: "key_scope = 'project' AND " },
    { table: 'direct_conversations', where: "crypto_scope = 'project' AND " },
    { table: 'agent_conversations', where: "crypto_scope = 'project' AND " },
];

/** Whether anything is sealed under this project's key. A table that does not exist holds nothing. */
async function holdsSealedContent(facade, projectId) {
    for (const { table, where } of SEALED_TABLES) {
        const present = await facade.getAll(`SELECT to_regclass('${table}') IS NOT NULL AS present`);
        if (present[0]?.present !== true) continue;
        const rows = await facade.getAll(`SELECT 1 AS hit FROM ${table} WHERE ${where}project_id = $1 LIMIT 1`, [projectId]);
        if (rows.length > 0) return true;
    }
    return false;
}

/**
 * @param {{ db?: { getAll: Function, run: Function }, resolveOrg?: (ownerId: string) => Promise<string|null>, initSchema?: Function }} [deps]
 * @returns {Promise<number>} how many projects were given an organisation
 */
async function up({ db = null, resolveOrg = ownerOrg, initSchema = null } = {}) {
    const facade = db || require('../db');
    // The projects table is the project store's; boot runs this ladder next to the store inits.
    await (initSchema || require('../stores/projectStore').initDB)();
    const rows = await facade.getAll(`SELECT id, owner_id FROM projects WHERE COALESCE(organization_id, '') = ''`);
    const orgByOwner = new Map();
    let stamped = 0;
    let skipped = 0;
    for (const row of rows) {
        if (!row.owner_id) continue;
        if (!orgByOwner.has(row.owner_id)) orgByOwner.set(row.owner_id, await resolveOrg(row.owner_id));
        const org = orgByOwner.get(row.owner_id);
        if (!org) continue;
        if (await holdsSealedContent(facade, row.id)) { skipped++; continue; }
        const res = await facade.run(
            `UPDATE projects SET organization_id = $1 WHERE id = $2 AND COALESCE(organization_id, '') = ''`,
            [org, row.id],
        );
        stamped += res?.rowCount ?? 0;
    }
    console.log(`[Migration] project-org-backfill-2026-09 applied (${stamped} project${stamped === 1 ? '' : 's'} given their owner's organisation${skipped ? `, ${skipped} left as they are because content is sealed under their key` : ''})`);
    return stamped;
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
