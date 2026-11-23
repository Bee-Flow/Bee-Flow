// @typecheck strict
/**
 * What a new organisation starts with, once its plan is assigned (stores/user/organizations.js createOrganization):
 *
 *   - its encryption tier (stores/initialTier.js). AWAITED: entitlement is resolved from the org's plan, so it runs
 *     after the plan assignment, and before the caller attaches the founding user; any write that beats it is written
 *     in plaintext. It narrows to 'none' on every failure, so org creation cannot fail on it;
 *   - Cowork's Privacy Shield on for its plain prompt runs (core/entitlements/coworkShieldFlag.js).
 *
 * Neither throws.
 */

'use strict';

const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { applyDefaultEncryptionTier } = require('../initialTier');

/**
 * @param {string} orgId
 * @param {{ updateOrganization: (...args: never[]) => unknown, logAccessAudit: (...args: never[]) => unknown }} userStore  the store functions the tier writes with
 */
async function applyNewOrganisationDefaults(orgId, userStore) {
    try {
        await applyDefaultEncryptionTier(orgId, { userStore });
    } catch (e) {
        log.error('[UserStore] initial encryption tier could not be applied:', /** @type {Error} */ (e).message);
    }
    await require('../../core/entitlements/coworkShieldFlag').enableForNewOrganisation(orgId)
        .catch((/** @type {unknown} */ e) => bestEffort('stores/user/newOrgDefaults:coworkShield', e));
}

module.exports = { applyNewOrganisationDefaults };
