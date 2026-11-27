// @typecheck strict
'use strict';
/**
 * The mounts of module "datatables": its row of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow), with the same gates. Order: the
 * core's (modules/firstParty/order.json "mounts"); the router is required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // Datatables: organisation-scoped tables automations read and write. Same module
    // and licence key as automations — the Community line. SHARING inside the
    // router is separately gated on 'automation_sharing' (Enterprise), while
    // reads and row writes stay ungated so a licence lapse never strands a
    // running automation. Mounted on its own path, not under /api/automation, whose
    // route table is frozen by automation.routetable.test.js.
    { key: 'datatables:/api/datatables', slot: 'main', path: '/api/datatables', handlers: (g) => [g.requireModule('automation'), g.requireAuthedUser, g.requireLicenseFeature('automations'), g.requireTraining('datatables'), require('../routes/datatables')] },
];

module.exports = { mounts };
