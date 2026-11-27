// @typecheck strict
'use strict';
/**
 * The mounts of module "support": its rows of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow), with the same gates. Order: the
 * core's (modules/firstParty/order.json "mounts"); routers are required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // Customer Support — Bee Flow's own AI-first support inbox. Mounted publicly
    // (no license/beta gate) because the POST /threads endpoint accepts anonymous
    // submissions from the marketing site; staff-only endpoints enforce
    // admin_support inside the router.
    { key: 'support:/api/support', slot: 'main', path: '/api/support', handlers: (g) => [g.requireModule('support'), require('../routes/support')] },
    // Support Studio — tenant customer-support inbox (Studio → Support). Compound
    // beta; the org-level support_inbox permission is additionally enforced inside.
    { key: 'support:/api/support-inbox', slot: 'main', path: '/api/support-inbox', handlers: (g) => [g.requireModule('support'), g.requireCapability('support_inbox'), require('../routes/supportInbox')] },
];

module.exports = { mounts };
