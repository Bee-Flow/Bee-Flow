// @typecheck strict
/**
 * The loose migrations of the module "learning" (part of firstParty/learning.js,
 * see modules/firstParty/parts.js). The row was the module's entry of
 * boot/bootMigrations.js LOOSE_MIGRATIONS; its order stays the core's
 * (modules/firstParty/order.json).
 */

'use strict';

/** @type {string[]} */
const migrations = [
    // Learning Center progress follows the lessons that were renamed from "routine" to
    // "automation" (lesson, exercise, course and badge ids).
    'learning-routine-ids-2026-10',
];

module.exports = { migrations };
