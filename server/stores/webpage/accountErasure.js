// @typecheck strict
/**
 * The web pages' part of account erasure: the `content` port's eraseWebpages
 * (projects/accountContentErasure.js, core) asks for this file by name (moduleForDataDuty), so the
 * SQL about this module's table lives here.
 */

'use strict';

const { getAll, run } = require('../../db');

/**
 * Web pages: the objects under the page's prefix (scripts, versions, extra
 * files, the page database) and then the row; versions, sources, extra-file
 * and public-share rows cascade on the FK. A plain DELETE rather than
 * deleteWebpage: that one refuses a page filed into a Solution stage
 * (retired by a deploy, never deleted), and an account erasure is not a deploy.
 * @param {string} userId
 */
async function eraseWebpages(userId) {
    const webpageStore = require('../webpageStore');
    const rows = await getAll('SELECT id FROM webpages WHERE user_id = $1', [userId]);
    for (const r of rows) {
        await webpageStore.purgeWebpageObjects(userId, r.id);
        await run('DELETE FROM webpages WHERE id = $1 AND user_id = $2', [r.id, userId]);
    }
    return rows.length;
}

module.exports = { eraseWebpages };
