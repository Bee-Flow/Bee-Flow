// @typecheck strict
/**
 * Directory reads that see the whole source tree.
 *
 * The tree is kept in several roots (server/ and modules/<id>/server/, see moduleRoots.cjs), so
 * `fs.readdirSync(path.join(__dirname, 'x'))` only sees the part of `x` that sits in the reader's
 * own root. A registry that finds its entries by reading a directory uses `dirEntries` instead:
 * for a directory of the tree it is `listTreeDir` over every root; for any other directory (a
 * fixture in a temp dir) it is a plain read. Both are sorted by name, so with one root the result
 * is what `fs.readdirSync(dir).sort()` gave.
 *
 * `walkTreeFiles` is the recursive form, for the scans that read every file of the tree, and
 * `treeFileAt` finds one file of the tree at the place a path computed from `__dirname` names.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { listTreeDir, toTreePath, treePath } = require('../moduleRoots.cjs');

/** @typedef {{ name: string, abs: string }} DirEntry */

/**
 * The entries of a directory, sorted by name; none when it does not exist.
 * @param {string} dir absolute path (a directory of the tree, or any other directory)
 * @returns {DirEntry[]}
 */
function dirEntries(dir) {
    const tree = toTreePath(path.resolve(dir));
    if (tree !== null) return listTreeDir(tree).map(({ name, abs }) => ({ name, abs }));
    /** @type {string[]} */
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
        throw e;
    }
    return names.sort().map((name) => ({ name, abs: path.join(dir, name) }));
}

/**
 * A file of the tree at the place `abs` names, in whichever root holds it (moduleRoots.cjs
 * treePath): `path.join(__dirname, 'steps', f)` keeps finding `f` when the steps directory is
 * split over several roots. A path outside every root is returned as it is.
 * @param {string} abs absolute path
 */
function treeFileAt(abs) {
    const tree = toTreePath(path.resolve(abs));
    return tree === null ? abs : treePath(tree);
}

/**
 * Is `abs` a directory (not a link to one, like a `Dirent` says)?
 * @param {string} abs
 */
function isDirectory(abs) {
    try {
        return fs.lstatSync(abs).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Every file below `dir`, depth first in name order, as `{ rel, abs }`: `rel` is the path below
 * `dir` with forward slashes, the same whichever root the file sits in.
 * @param {string} dir absolute path
 * @param {{ skipDir?: (name: string) => boolean, keepFile?: (name: string) => boolean }} [filters]
 * @returns {Generator<{ rel: string, abs: string }>}
 */
function* walkTreeFiles(dir, { skipDir = () => false, keepFile = () => true } = {}) {
    for (const entry of dirEntries(dir)) {
        if (isDirectory(entry.abs)) {
            if (skipDir(entry.name)) continue;
            for (const below of walkTreeFiles(entry.abs, { skipDir, keepFile })) {
                yield { rel: `${entry.name}/${below.rel}`, abs: below.abs };
            }
        } else if (keepFile(entry.name)) {
            yield { rel: entry.name, abs: entry.abs };
        }
    }
}

module.exports = { dirEntries, walkTreeFiles, treeFileAt, isDirectory };
