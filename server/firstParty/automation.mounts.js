// @typecheck strict
'use strict';
/**
 * The mounts of module "automation": its rows of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow), with the same gates. Order: the
 * core's (modules/firstParty/order.json "mounts"); routers are required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // The org switch for showing images to AI in automations.
    { key: 'automation:/api/org-automation-image-ai', slot: 'main', path: '/api/org-automation-image-ai', handlers: () => [require('../routes/orgAutomationImageAi.mts').orgAutomationImageAiRouter] },
    { key: 'automation:/api/automation/builder', slot: 'main', path: '/api/automation/builder', handlers: (g) => [g.requireModule('automation'), g.requireLicenseFeature('automations'), require('../routes/ai/automationBuilder')] },
    { key: 'automation:/api/automation', slot: 'main', path: '/api/automation', handlers: (g) => [g.requireModule('automation'), g.requireLicenseFeature('automations'), g.requireTraining('automations'), require('../routes/automation')] },
    { key: 'automation:/api/step', slot: 'main', path: '/api/step', handlers: (g) => [g.requireModule('automation'), g.requireLicenseFeature('automations'), require('../routes/step')] },
];

module.exports = { mounts };
