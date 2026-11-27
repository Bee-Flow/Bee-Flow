// @typecheck strict
'use strict';
/**
 * The mounts of module "int_saas" (LinkedIn, Withings, GitHub, Gamma): its rows of the route
 * table that the core mounts, as data (modules/firstParty/contract.js MountRow).
 * Order: the core's (modules/firstParty/order.json "mounts"); routers are required at mount
 * time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    { key: 'int_saas:/api/integrations/linkedin', slot: 'main', path: '/api/integrations/linkedin', handlers: () => [require('../routes/integrations/linkedin')] },
    { key: 'int_saas:/api/integrations/withings', slot: 'main', path: '/api/integrations/withings', handlers: () => [require('../routes/integrations/withings')] },
    { key: 'int_saas:/api/integrations/github', slot: 'main', path: '/api/integrations/github', handlers: () => [require('../routes/integrations/github')] },
    { key: 'int_saas:/api/integrations/github-sync', slot: 'main', path: '/api/integrations/github-sync', handlers: () => [require('../routes/integrations/githubSync')] },
    { key: 'int_saas:/api/integrations/gamma', slot: 'main', path: '/api/integrations/gamma', handlers: () => [require('../routes/integrations/gamma')] },
];

module.exports = { mounts };
