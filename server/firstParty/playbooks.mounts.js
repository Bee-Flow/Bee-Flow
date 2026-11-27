// @typecheck strict
'use strict';
/**
 * The mounts of module "playbooks": its row of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow), with the same gates. Order: the
 * core's (modules/firstParty/order.json "mounts"); the router is required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // Studio Playbooks — phased AI builds (table → automation → fill → app →
    // approvals). A playbook owns an automation AND an app, so both modules and both
    // gates apply; writes need manage_apps (router-level); the approvals phase is
    // locked without the approvals capability (checked in the handler).
    { key: 'playbooks:/api/playbooks', slot: 'main', path: '/api/playbooks', handlers: (g) => [g.requireModule('apps'), g.requireModule('automation'), g.requireCapability('app_studio'), g.requireLicenseFeature('automations'), g.requireTraining('playbooks'), require('../routes/playbooks')] },
];

module.exports = { mounts };
