// @typecheck strict
/**
 * Composition of the first-party module "int_saas" (SaaS tools): the SaaS tool families
 * (Fireflies, Gamma, GitHub, LinkedIn, Withings and others).
 *
 * What this module adds to the server's composition (mounts, registrations, startup jobs,
 * shutdown, stores, migrations) is in the part files beside this one, merged by withParts
 * (modules/firstParty/parts.js, contract in modules/firstParty/contract.js). The loader
 * (modules/firstParty/loader.js) finds this file through the tree; nothing requires it by
 * path. requires and uses are those of scripts/module-map.json (held equal by
 * modules/firstParty/compositions.test.js).
 */

'use strict';

const { withParts } = require('../modules/firstParty/parts');

module.exports = withParts({
    id: 'int_saas',
    requires: [],
    uses: ['automation', 'cowork'],
    // The capabilities it offers (core/entitlements/capabilityRegistry.js ids); they leave the projection while it is absent.
    capabilities: [
        'fireflies', 'gamma', 'signrequest', 'scaleway-billing', 'youtrack', 'github', 'n8n', 'linkedin',
        'withings',
    ],
});
