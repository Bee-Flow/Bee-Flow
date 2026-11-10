// @typecheck strict
/**
 * The one place the connector bootstrap and sign-in reach up into services/:
 * the org-health recorder, the plan entitlements and the stored-uid question.
 * connectorBootstrap.js, connectorJwt.js and the modules they are split into
 * take them from here, so a split adds no auth -> services edge
 * (server/layering.test.js counts every require).
 */

const orgHealth = require('../../services/orgHealth');
const planEntitlements = require('../../services/planEntitlements');

/**
 * Is the Nextcloud uid stored on a user still a live account with this e-mail
 * address? (services/ncStoredUid.mts, loaded on first use: it pulls in the sync.)
 * @param {{ id?: string, [key: string]: unknown } | null | undefined} org
 * @param {string} storedUid
 * @param {string} email
 * @returns {Promise<boolean>}
 */
function storedUidIsLiveWithEmail(org, storedUid, email) {
    return require('../../services/ncStoredUid.mts').storedUidIsLiveWithEmail(org, storedUid, email);
}

module.exports = { orgHealth, planEntitlements, storedUidIsLiveWithEmail };
