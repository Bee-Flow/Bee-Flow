// @typecheck strict
'use strict';
/**
 * The mounts of module "templates": its rows of the route table of server/index.js and of the
 * /ai router (routes/ai.js), as data (modules/firstParty/contract.js MountRow). Order: the
 * core's (modules/firstParty/order.json "mounts" and "aiMounts"); routers are required at
 * mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    { key: 'templates:/api/templates', slot: 'main', path: '/api/templates', handlers: () => [require('../routes/templates')] },
];

/** @type {MountRow[]} */
const aiMounts = [
    { key: 'templates:templateChat', path: '/', handlers: () => [require('../routes/ai/templateChat')] },
];

module.exports = { mounts, aiMounts };
