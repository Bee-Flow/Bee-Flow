// @typecheck strict
/**
 * App Studio's part of account erasure: the `content` port's eraseStudioApps
 * (projects/accountContentErasure.js, core) asks for this file by name (moduleForDataDuty), so the
 * SQL about this module's table lives here.
 */

'use strict';

const { getAll } = require('../../db');

/**
 * App Studio apps: through the store's delete, which purges the per-app
 * database and the attachment objects before the rows.
 * @param {string} userId
 */
async function eraseStudioApps(userId) {
    const studioAppStore = require('../studioAppStore');
    const rows = await getAll('SELECT id FROM studio_apps WHERE user_id = $1', [userId]);
    for (const r of rows) await studioAppStore.deleteStudioApp(r.id, userId);
    return rows.length;
}

module.exports = { eraseStudioApps };
