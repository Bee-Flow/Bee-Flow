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
    for (const row of rows) {
        if (!row.owner_id) continue;
        if (!orgByOwner.has(row.owner_id)) orgByOwner.set(row.owner_id, await resolveOrg(row.owner_id));
        const org = orgByOwner.get(row.owner_id);
        if (!org) continue;
        const res = await facade.run(
            `UPDATE projects SET organization_id = $1 WHERE id = $2 AND COALESCE(organization_id, '') = ''`,
            [org, row.id],
        );
        stamped += res?.rowCount ?? 0;
    }
    console.log(`[Migration] project-org-backfill-2026-09 applied (${stamped} project${stamped === 1 ? '' : 's'} given their owner's organisation)`);
    return stamped;
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
