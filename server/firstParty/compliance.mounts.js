// @typecheck strict
'use strict';
/**
 * The mounts of module "compliance": its rows of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow), with the same gates. Order: the
 * core's (modules/firstParty/order.json "mounts"); routers are required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // Compliance Hub — Enterprise-tier feature.
    { key: 'compliance:/api/compliance', slot: 'main', path: '/api/compliance', handlers: (g) => [g.requireModule('compliance'), /** @type {import('express').RequestHandler} */ ((req, res, next) => require('../core/entitlements/entitlements').requireCapability('compliance_hub_gdpr')(req, res, next)), require('../routes/compliance')] },
    // DSR — public submission must remain reachable (GDPR Art. 12). Admin endpoints
    // inside the router enforce admin_compliance permission; the router is mounted
    // without the license gate so unauthenticated subjects can submit requests.
    { key: 'compliance:/api/dsr', slot: 'main', path: '/api/dsr', handlers: (g) => [g.requireModule('compliance'), require('../routes/dsr')] },
];

module.exports = { mounts };
