// @typecheck strict
/**
 * App Studio catalog — the file-per-item registries.
 *
 * A registry is a directory with one CommonJS file per item (componentSpecs/types/<type>.js,
 * componentSpecs/styleKnobGroups/<group>.js). The item's name is its file name, the files are
 * read in sorted order and loaded AFTER the base lists, so an addition is a new file and never
 * an edit of a shared list. A missing directory is an empty registry: git keeps no empty
 * directories, and every registry ships empty until a feature adds its first file.
 *
 * Plain `.js` only: the web and phone tests require the spec directly, without a transform.
 */

'use strict';

const { dirEntries } = require('../../utils/treeDir');

const ITEM_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The registry files of `dir` as `{ name, file }`, sorted by name. A directory of the source tree
 * is read over every root (utils/treeDir.js), so an item may live in another module's root.
 * @param {string} dir
 * @returns {Array<{ name: string, file: string }>}
 */
function listRegistryFiles(dir) {
    const out = [];
    for (const { name: entry, abs } of dirEntries(dir)) {
        if (!entry.endsWith('.js') || entry.endsWith('.test.js')) continue;
        const name = entry.slice(0, -'.js'.length);
        if (!ITEM_NAME.test(name)) throw new Error(`${abs}: a registry file is named <lower_snake_case>.js`);
        out.push({ name, file: abs });
    }
    return out;
}

/**
 * The `since` an extension item must carry: an integer of at least 3 (2 is the frozen base).
 * @param {unknown} since
 * @param {string} where
 * @returns {number}
 */
function requireSince(since, where) {
    if (typeof since !== 'number' || !Number.isInteger(since) || since < 3) {
        throw new Error(`${where}: an extension carries an integer "since" of 3 or more`);
    }
    return since;
}

module.exports = { listRegistryFiles, requireSince };
