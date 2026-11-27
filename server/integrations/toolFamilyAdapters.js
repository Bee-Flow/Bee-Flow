// @typecheck strict
/**
 * The two adapters the integration tool families share (integrations/toolFamilies.js for the
 * core's families, firstParty/<id>.register.js for a module's): most integration executors take
 * the user id or the session as their third argument instead of the dispatcher's context, and a
 * module registers its list of families in one call.
 */

'use strict';

/** @typedef {import('./toolFamilies').IntegrationToolFamily} IntegrationToolFamily */
/** @typedef {import('./toolFamilies').ToolArgs} ToolArgs */
/**
 * A module's family as its register part writes it: the dispatcher's context is read as
 * loosely as integrations/toolFamilies.js (noImplicitAny) read it, so the rows could move
 * unchanged into strict files.
 * @typedef {Omit<IntegrationToolFamily, 'isTool' | 'execute'> & {
 *   isTool: (n: string) => unknown, execute: (n: string, a: ToolArgs, ctx: any) => unknown }} ModuleToolFamily
 */

/**
 * Families whose executor takes (toolName, toolArgs, userId).
 * @param {(n: string, a: ToolArgs, userId: string) => unknown} execute
 * @returns {IntegrationToolFamily['execute']}
 */
const byUser = (execute) => (name, args, ctx) => execute(name, args, /** @type {string} */ (ctx.userId));

/**
 * Families whose executor takes (toolName, toolArgs, session).
 * @param {(n: string, a: ToolArgs, session: Express.Session) => unknown} execute
 * @returns {IntegrationToolFamily['execute']}
 */
const bySession = (execute) => (name, args, ctx) => execute(name, args, /** @type {Express.Session} */ (ctx.session));

/**
 * Register a list of families with core's dispatcher (core/tools/toolFamilyRegistry.js).
 * @param {ModuleToolFamily[]} families
 */
function registerFamilies(families) {
    const { registerToolFamily } = require('../core/tools/toolFamilyRegistry');
    for (const family of families) registerToolFamily(/** @type {IntegrationToolFamily} */ (/** @type {unknown} */ (family)));
}

module.exports = { byUser, bySession, registerFamilies };
