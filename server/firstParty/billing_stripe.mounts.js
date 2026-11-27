// @typecheck strict
'use strict';
/**
 * The mounts of module "billing_stripe": its rows of the route table that server/index.js used
 * to hold, as data (modules/firstParty/contract.js MountRow). Order: the core's
 * (modules/firstParty/order.json "mounts"); routers are required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    { key: 'billing_stripe:/api/stripe', slot: 'main', path: '/api/stripe', handlers: () => [require('../routes/stripe')] },
    { key: 'billing_stripe:/api/billing', slot: 'main', path: '/api/billing', handlers: () => [require('../routes/billing')] },
];

module.exports = { mounts };
