// @typecheck strict
/**
 * Module roots: one source tree, kept in several directories.
 *
 * The core lives in server/. A first-party module lives in modules/<id>/server/ and
 * keeps, for every file, the path that file has relative to its root (its TREE PATH):
 *
 *     server/core/llm/llmClient.js                    tree path core/llm/llmClient.js   (core)
 *     modules/automation/server/automation/goLive.js  tree path automation/goLive.js    (module)
 *
 * The roots together are one tree: every tree path exists in exactly one root. This file
 * makes Node resolve it that way. A request that fails where it points is looked up at the
 * same tree path in the other roots, so `require('../core/llm/llmClient')` written in a module
 * file keeps working after that file moved out of server/, and no import line changes when
 * a file moves. A module that is not present is simply not found.
 *
 * What is covered: require(), require.resolve(), createRequire(), static and dynamic
 * import, for relative and absolute requests (modules/roots/resolveHooks.cjs). A package
 * name asked for from a module root is resolved from the core root first, so a module uses
 * the core's installed packages.
 *
 * What is NOT covered is a path computed by hand (`path.join(__dirname, '..', 'x')`): that
 * is file access, not module resolution. Use the helpers below instead:
 *
 *     treePath('templates/x.md')       a file of the tree, wherever its owner lives
 *     listTreeDir('i18n/defaults/en')  a directory of the tree, joined over all roots
 *     dataPath('uploads')              run-time data; always beside the core
 *     repoPath('agent-hub')            something outside the tree, beside server/
 *
 * Where the roots come from, and core mode (BEEFLOW_HIDE_MODULES, which makes the files of
 * the named modules count as absent): modules/roots/rootSet.cjs. A production image built
 * as one merged tree has no module directory: nothing is patched there.
 *
 * Loading: `node --require ./moduleRoots.cjs`, normally through NODE_OPTIONS so worker
 * threads and child processes get it too. Requiring it twice is harmless.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CORE_ROOT, ROOTS, readDir, rootOf, toTreePath, hiddenOwner, rootHidden } = require('./modules/roots/rootSet.cjs');
const { install } = require('./modules/roots/resolveHooks.cjs');
const { duplicateTreePaths } = require('./modules/roots/treeCheck.cjs');

/** @typedef {{ name: string, abs: string, moduleId: string | null }} TreeEntry */

/**
 * The absolute path of a file or directory of the tree. When no root has it, the path in
 * the core root is returned, so the error a caller then gets names the usual place.
 * @param {...string} segments tree path, in one or more pieces
 */
function treePath(...segments) {
    const rel = path.join(...segments);
    for (const root of ROOTS) {
        const candidate = path.join(root.dir, rel);
        if (!rootHidden(root) && fs.existsSync(candidate) && !hiddenOwner(candidate)) return candidate;
    }
    return path.join(CORE_ROOT, rel);
}

/**
 * The entries of a directory of the tree, joined over every root that has it, by name.
 * @param {...string} segments tree path of the directory
 * @returns {TreeEntry[]}
 */
function listTreeDir(...segments) {
    const rel = path.join(...segments);
    /** @type {Map<string, TreeEntry>} */
    const seen = new Map();
    for (const root of ROOTS) {
        if (rootHidden(root)) continue;
        for (const entry of readDir(path.join(root.dir, rel))) {
            const abs = path.join(root.dir, rel, entry.name);
            if (!seen.has(entry.name) && !hiddenOwner(abs)) seen.set(entry.name, { name: entry.name, abs, moduleId: root.id });
        }
    }
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Run-time data (uploads, caches, downloaded media). It belongs to the installation, not
 * to the code, so it stays beside the core wherever the code that uses it lives.
 * @param {...string} segments path below the data directory
 */
function dataPath(...segments) {
    return path.join(CORE_ROOT, 'data', ...segments);
}

/**
 * A path outside the tree, beside server/ (agent-hub, components, docs in a checkout).
 * @param {...string} segments path below the directory that holds server/
 */
function repoPath(...segments) {
    return path.resolve(CORE_ROOT, '..', ...segments);
}

install();

module.exports = {
    coreRoot: CORE_ROOT,
    roots: () => ROOTS.map((root) => ({ ...root })),
    rootOf,
    toTreePath,
    treePath,
    listTreeDir,
    dataPath,
    repoPath,
    hiddenOwner,
    duplicateTreePaths,
};
