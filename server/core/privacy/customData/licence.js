'use strict';
/**
 * Does the TARGET org have the "Your own data" feature?
 *
 * The bench routes act on the org named in the URL, so `requireFeature`
 * (scoped to the caller's own org) is the wrong gate. The question asked here
 * is the one the runtime asks before it ENFORCES an org's types
 * (core/privacy/customTypes/resolve.js `hasCustomDataFeature`):
 * license.hasFeature over the org alone, which is the org's tier plus any
 * feature its plan grants on top. Deliberately without the caller's own
 * tier: a personal licence must not open a bench for types the org's shield
 * would then not enforce. A licence module without hasFeature falls back to
 * resolveTier + tierHasFeature, the way routes/orgPrivacyShield.js clamps.
 *
 * Fails CLOSED: a feature that cannot be resolved is "no feature".
 */

const FEATURE = 'custom_data_types';

function createLicenceCheck({ license = null, log = null } = {}) {
    const lic = () => license || require('../../../license');
    const logger = () => log || require('../../../telemetry/log');
    return async function orgHasCustomDataTypes({ organizationId }) {
        if (!organizationId) return false;
        try {
            const l = lic();
            if (typeof l.hasFeature === 'function') return !!(await l.hasFeature({ organizationId }, FEATURE));
            const tier = await l.resolveTier({ organizationId });
            return !!l.tiers.tierHasFeature(tier, FEATURE);
        } catch (e) {
            logger().warn('[CustomData] licence check failed; treating the feature as locked:', e?.message || e);
            return false;
        }
    };
}

module.exports = { FEATURE, createLicenceCheck, orgHasCustomDataTypes: createLicenceCheck() };
