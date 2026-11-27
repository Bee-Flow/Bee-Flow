// @typecheck strict
'use strict';
/**
 * The mounts of module "sanctions": its row of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow). Order: the core's
 * (modules/firstParty/order.json "mounts"); the router is required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // The imported sanctions lists: super-admin only, the router enforces it.
    { key: 'sanctions:/api/admin/sanctions-lists', slot: 'main', path: '/api/admin/sanctions-lists', handlers: () => [require('../routes/admin/sanctionsLists.mts').sanctionsListsRouter] },
];

module.exports = { mounts };
