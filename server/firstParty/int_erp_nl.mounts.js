// @typecheck strict
'use strict';
/**
 * The mounts of module "int_erp_nl" (Nmbrs, 2BA): its rows of the route table that
 * the core mounts, as data (modules/firstParty/contract.js MountRow). Order: the
 * core's (modules/firstParty/order.json "mounts"); routers are required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    { key: 'int_erp_nl:/api/integrations/nmbrs', slot: 'main', path: '/api/integrations/nmbrs', handlers: () => [require('../routes/integrations/nmbrs')] },
    { key: 'int_erp_nl:/api/integrations/twoba', slot: 'main', path: '/api/integrations/twoba', handlers: () => [require('../routes/integrations/twoba.mts').twobaRouter] },
];

module.exports = { mounts };
