// @typecheck strict
'use strict';
/**
 * The mounts of module "cowork": its row of the route table that the core mounts,
 * as data (modules/firstParty/contract.js MountRow). Order: the core's
 * (modules/firstParty/order.json "mounts"); the router is required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // Cowork — scheduled work from the Chat ⇄ Work switch, with per-run history.
    // Ungated: running an item as an agent is beta-gated (agent_routines) per route.
    // The old /api/ai-tasks is gone; its rows moved here (agent-tasks-to-cowork-2026-10).
    { key: 'cowork:/api/cowork', slot: 'main', path: '/api/cowork', handlers: (g) => [g.requireTraining('cowork'), require('../routes/cowork')] },
];

module.exports = { mounts };
