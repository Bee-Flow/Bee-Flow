// @typecheck
'use strict';

// Split from documentSharing so stores/user/groups can revoke shares without
// pulling in the sharing crypto (which reaches back into auth/ and userStore).
const { getAll, run } = require('../../db');

async function revokeGroupShares(groupId) {
    // Stores are initialized independently; only touch installed sharing columns.
    const tables = await getAll(`SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('studio_documents', 'notebooks')
        AND column_name = 'shared_groups'`);
    for (const { table_name: table } of tables) {
        await run(`UPDATE ${table} SET shared_groups = shared_groups - $1::text WHERE shared_groups ? $1`, [groupId]);
    }
}

module.exports = { revokeGroupShares };
