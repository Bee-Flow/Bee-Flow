// @typecheck
'use strict';
/**
 * May an organisation use the Privacy Shield "tokenize" action?
 *
 * One answer for the two places that need it (the save/read route and the
 * runtime resolver), so what the admin sees is what runs. Judged on the TARGET
 * org (its tier, or an explicit plan grant through `license.hasFeature`), never
 * on the caller's own tier. Fails closed: any resolver error answers false.
 */

const FEATURE = 'pii_tokenize';

/**
 * @param {() => any} getLicence  the licence module (lazy in the callers)
 * @param {string | null | undefined} organizationId
 * @returns {Promise<boolean>}
 */
async function orgMayTokenize(getLicence, organizationId) {
    try {
        const lic = getLicence();
        const scope = { organizationId };
        if (typeof lic.hasFeature === 'function') return !!(await lic.hasFeature(scope, FEATURE));
        return !!lic.tiers.tierHasFeature(await lic.resolveTier(scope), FEATURE);
    } catch (_) {
        return false;
    }
}

/**
 * The action the org may actually use: 'tokenize' only with the feature,
 * otherwise 'block' (the stricter one). Anything else passes through.
 * @param {() => any} getLicence
 * @param {string} action
 * @param {string | null | undefined} organizationId
 * @returns {Promise<string>}
 */
async function allowedAction(getLicence, action, organizationId) {
    if (action !== 'tokenize') return action;
    return (await orgMayTokenize(getLicence, organizationId)) ? action : 'block';
}

module.exports = { orgMayTokenize, allowedAction, FEATURE };
