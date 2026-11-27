// @typecheck strict
/**
 * The one-root-per-tree-path rule, checked.
 *
 * Every tree path a module root holds must exist in that root only, and a file `x.js` may
 * not stand beside a directory `x/` of another root that can answer a request itself (it
 * holds an `index.*` or a `package.json`), in either direction: with either, which file a
 * request for `./x` lands on would depend on who asks. A directory without such an entry
 * point is no clash: `routes/ai.js` in the core and `routes/ai/learning.js` in a module is
 * the ordinary shape of a split directory. Not run on load (it walks the module roots): the
 * server calls it once at boot and the repository checks call it in CI.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CORE_ROOT, ROOTS, readDir } = require('./rootSet.cjs');

/** Files a root may hold beside its tree: they configure the root, they are not part of it. */
const ROOT_CONTROL_FILES = new Set(['node_modules', 'eslint.config.js', 'eslint-suppressions.json', 'coverage']);

/**
 * @param {string} dir absolute
 * @param {string} rel tree path of dir, '' for the root
 * @param {{ files: string[], dirs: string[] }} out tree paths of the files and directories below dir
 */
function collectFiles(dir, rel, out) {
    for (const entry of readDir(dir)) {
        if (rel === '' && ROOT_CONTROL_FILES.has(entry.name)) continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.dirs.push(child);
            collectFiles(path.join(dir, entry.name), child, out);
        } else {
            out.files.push(child);
        }
    }
}

/**
 * The files of the core root named `<dir>.<ext>`: they shadow the directory `dir` of a
 * module root. (A module file next to a module directory is found from the file's side.)
 * @param {string} dir tree path of a directory in a module root
 * @returns {string[]} their tree paths
 */
function coreFilesShadowing(dir) {
    const parent = path.posix.dirname(dir);
    const base = path.posix.basename(dir);
    return readDir(path.join(CORE_ROOT, parent))
        .filter((entry) => !entry.isDirectory() && entry.name.replace(/\.[^.]+$/, '') === base && entry.name !== base)
        .map((entry) => (parent === '.' ? entry.name : `${parent}/${entry.name}`));
}

/**
 * Can a request for this directory be answered by the directory itself?
 * @param {string} dir absolute
 */
function hasEntryPoint(dir) {
    return readDir(dir).some((entry) => !entry.isDirectory() && (/^index\.[^.]+$/.test(entry.name) || entry.name === 'package.json'));
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
        /** @type {{ files: string[], dirs: string[] }} */
        const found = { files: [], dirs: [] };
        collectFiles(root.dir, '', found);
        for (const dir of found.dirs) {
            if (!hasEntryPoint(path.join(root.dir, dir))) continue;
            for (const rel of coreFilesShadowing(dir)) clashes.push({ treePath: rel, roots: [null, root.id] });
        }
        for (const rel of found.files) {
            const stem = rel.replace(/\.[^./]+$/, '');
            const holders = ROOTS.filter((other) => other !== root
                && (fs.existsSync(path.join(other.dir, rel)) || hasEntryPoint(path.join(other.dir, stem))));
            if (holders.length > 0) clashes.push({ treePath: rel, roots: [root.id, ...holders.map((h) => h.id)] });
        }
    }
    return clashes;
}

module.exports = { duplicateTreePaths, ROOT_CONTROL_FILES };
