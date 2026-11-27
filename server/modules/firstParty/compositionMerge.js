// @typecheck strict
'use strict';
/**
 * One list of the server's composition from two halves: the core's own rows (a hand list
 * such as storeModules.js STORE_MODULES or boot/bootMigrations.js CORE_LOOSE_MIGRATIONS) and
 * the rows the loaded first-party modules contribute (modules/firstParty/loader.js
 * stores() / migrations()), sorted by the core's order index
 * (modules/firstParty/order.json). A name the index lists comes at its position; the
 * unlisted ones follow, the core's first, each half in its own order. A name the core
 * already has is not taken a second time from a module.
 */

const { orderRows } = require('./loaderRules');

/** Sorts after every module id ([A-Za-z0-9_]), so unlisted module rows follow unlisted core rows. */
const MODULE_ROWS = '~';

/**
 * @template R
 * @param {readonly R[]} core
 * @param {readonly R[]} contributed
 * @param {(row: R) => string} nameOf
 * @param {readonly string[]} listed the order index of this list
 * @returns {R[]}
 */
function mergeByOrder(core, contributed, nameOf, listed) {
    const coreNames = new Set(core.map(nameOf));
    const items = [
        ...core.map((row, index) => ({ moduleId: '', index, name: nameOf(row), row })),
        ...contributed.filter((row) => !coreNames.has(nameOf(row)))
            .map((row, index) => ({ moduleId: MODULE_ROWS, index, name: nameOf(row), row })),
    ];
    return orderRows(items, listed);
}

module.exports = { mergeByOrder };
