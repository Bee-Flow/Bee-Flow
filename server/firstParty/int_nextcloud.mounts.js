// @typecheck strict
'use strict';
/**
 * The mounts of module "int_nextcloud": its row of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow). Order: the core's
 * (modules/firstParty/order.json "mounts"); the router is required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // Nextcloud Task Processing execution. Machine-to-machine: authenticated by
    // the connector's tenant-key HMAC, not a session (see the route's header).
    { key: 'int_nextcloud:/api/nextcloud/task-processing', slot: 'main', path: '/api/nextcloud/task-processing', handlers: () => [require('../routes/nextcloudTaskProcessing')] },
];

module.exports = { mounts };
