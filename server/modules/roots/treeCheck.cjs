// @typecheck strict
/**
 * The one-root-per-tree-path rule, checked.
 *
 * Every tree path a module root holds must exist in that root only, and a file `x.js` may
 * not shadow a directory `x/` of another root: with either, which file a request lands on
 * would depend on who asks. Not run on load (it walks the module roots): the server calls
 * it once at boot and the repository checks call it in CI.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOTS, readDir } = require('./rootSet.cjs');

/** Files a root may hold beside its tree: they configure the root, they are not part of it. */
const ROOT_CONTROL_FILES = new Set(['node_modules', 'eslint.config.js', 'eslint-suppressions.json', 'coverage']);

/**
 * @param {string} dir absolute
 * @param {string} rel tree path of dir, '' for the root
 * @param {string[]} out tree paths of the files below dir
 */
function collectFiles(dir, rel, out) {
    for (const entry of readDir(dir)) {
        if (rel === '' && ROOT_CONTROL_FILES.has(entry.name)) continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) collectFiles(path.join(dir, entry.name), child, out);
        else out.push(child);
    }
}

/** @param {string} file */
function isDirectory(file) {
    try {
        return fs.statSync(file).isDirectory();
    } catch {
        return false;
    }
}

/**
 * The offending tree paths with the roots that hold them (null is the core root); an
 * empty list means the tree is sound.
 * @returns {{ treePath: string, roots: (string | null)[] }[]}
 */
function duplicateTreePaths() {
    /** @type {{ treePath: string, roots: (string | null)[] }[]} */
    const clashes = [];
    for (const root of ROOTS.slice(1)) {
        /** @type {string[]} */
        const files = [];
        collectFiles(root.dir, '', files);
        for (const rel of files) {
            const stem = rel.replace(/\.[^./]+$/, '');
            const holders = ROOTS.filter((other) => other !== root
                && (fs.existsSync(path.join(other.dir, rel)) || isDirectory(path.join(other.dir, stem))));
            if (holders.length > 0) clashes.push({ treePath: rel, roots: [root.id, ...holders.map((h) => h.id)] });
        }
    }
    return clashes;
}

module.exports = { duplicateTreePaths, ROOT_CONTROL_FILES };
