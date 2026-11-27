// @typecheck strict
/**
 * The server's source tree for whole-tree tests and kits: every root (server/ and each
 * modules/<id>/server, server/moduleRoots.cjs), walked as one tree of TREE PATHS.
 *
 *   walkServerTree()                         [{ treePath, abs, moduleId }] of every root
 *   walkServerTree({ under: 'routes' })      only below routes/ (a root without it is skipped)
 *   walkServerTree({ filter })               filter(treePath, dirent) false prunes a file or a directory
 *   treeJsFiles({ skipDirs })                the .js files (tests left out unless `tests: true`)
 *   readTreeFile('index.js')                 the text of a tree file, whichever root holds it
 *   treeFile('stores/x.js')                  its absolute path, or null when no root has it
 *   requestPlaces('core/a.js', '../b')       the absolute places a relative request may land on
 *
 * A guard test that walks server/ alone keeps passing after a module moved out, blind to
 * the moved code. This kit is that walk over every root, and it FAILS when a
 * root yields no file at all (for a walk of the whole tree, or with `everyRoot: true`), so a
 * blind walk cannot pass quietly.
 *
 * Like scripts/lib/roots.mjs: core root first, then the module roots by id, each sorted by
 * name (code-unit order) depth first; node_modules, coverage, dist and .git are skipped at
 * any depth, and the per-root control files (modules/roots/treeCheck.cjs ROOT_CONTROL_FILES)
 * at the top of a root unless `controlFiles: true`. With only the core root it gives exactly
 * what a plain walk of server/ gives. BEEFLOW_HIDE_MODULES does not apply: these tests read
 * source text, and every file that is present is part of it.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { roots, coreRoot, toTreePath } = require('../moduleRoots.cjs');
const { ROOT_CONTROL_FILES } = require('../modules/roots/treeCheck.cjs');
const { readDir } = require('../modules/roots/rootSet.cjs');

/** @typedef {{ treePath: string, abs: string, moduleId: string | null }} TreeFile */
/** @typedef {{ id: string | null, dir: string }} Root */
/**
 * filter: false prunes that file or directory; under: tree path of a directory, walk only below
 * it; skipDirs: names skipped at any depth, beside SKIP_DIRS; controlFiles: also yield the per-root
 * control files (eslint.config.js, ...); everyRoot: throw when a root yields nothing (default:
 * true without `under`).
 * @typedef {{
 *   filter?: (treePath: string, entry: fs.Dirent) => boolean,
 *   under?: string,
 *   skipDirs?: string[],
 *   controlFiles?: boolean,
 *   everyRoot?: boolean,
 * }} WalkOptions
 */

/** Names never walked or yielded, at any depth (the directories scripts/lib/roots.mjs skips). */
const SKIP_DIRS = Object.freeze(['node_modules', 'coverage', 'dist', '.git']);

/** @param {string} p */
const slash = (p) => p.split(path.sep).join('/');
/** Code-unit order of names, as scripts/lib/roots.mjs walks. @param {fs.Dirent} a @param {fs.Dirent} b */
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Depth first, by name; an unreadable directory yields nothing (rootSet.cjs readDir).
 * @param {Root} root
 * @param {string} rel tree path of the directory, '' for the root
 * @param {{ skip: Set<string>, otherRoots: Set<string>, opts: WalkOptions, out: TreeFile[] }} ctx
 */
function walkRoot(root, rel, ctx) {
    for (const entry of readDir(path.join(root.dir, rel)).sort(byName)) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        const abs = path.join(root.dir, child);
        // By name whatever the entry is: a node_modules link is no directory entry, and no source either.
        if (ctx.skip.has(entry.name) || (entry.isDirectory() && ctx.otherRoots.has(abs))) continue;
        if (rel === '' && !ctx.opts.controlFiles && ROOT_CONTROL_FILES.has(entry.name)) continue;
        if (ctx.opts.filter && !ctx.opts.filter(child, entry)) continue;
        if (entry.isDirectory()) walkRoot(root, child, ctx);
        else ctx.out.push({ treePath: child, abs, moduleId: root.id });
    }
}

/**
 * Every file of the tree, over every root.
 * @param {WalkOptions} [opts]
 * @returns {TreeFile[]}
 */
function walkServerTree(opts = {}) {
    const all = roots();
    const under = opts.under ? opts.under.replace(/\/+$/, '') : '';
    const everyRoot = opts.everyRoot ?? !under;
    const skip = new Set([...SKIP_DIRS, ...(opts.skipDirs || [])]);
    /** @type {TreeFile[]} */
    const out = [];
    const empty = [];
    for (const root of all) {
        const start = out.length;
        const otherRoots = new Set(all.filter((r) => r !== root).map((r) => r.dir));
        if (!under || fs.existsSync(path.join(root.dir, under))) walkRoot(root, under, { skip, otherRoots, opts, out });
        if (out.length === start) empty.push(`${root.id ?? 'core'} (${root.dir})`);
    }
    if (everyRoot && empty.length > 0) {
        throw new Error(`walkServerTree: no file found in ${empty.join(', ')}${under ? ` below ${under}` : ''}: the walk or its filter is blind there`);
    }
    return out;
}

/**
 * The .js files of every root (the walk most guard tests make), control files included.
 * @param {{ skipDirs?: string[], tests?: boolean, dotNames?: boolean }} [opts]
 *   skipDirs: beside SKIP_DIRS; tests: keep `*.test.js` too; dotNames: false skips every name starting with a dot
 * @returns {TreeFile[]}
 */
function treeJsFiles({ skipDirs = [], tests = false, dotNames = true } = {}) {
    return walkServerTree({
        skipDirs,
        controlFiles: true,
        filter: (_rel, e) => {
            if (!dotNames && e.name.startsWith('.')) return false;
            if (e.isDirectory()) return true;
            return e.isFile() && e.name.endsWith('.js') && (tests || !e.name.endsWith('.test.js'));
        },
    });
}

/**
 * The absolute path of a file of the tree: the first root (core first) that holds it as a file.
 * @param {string} treePath
 * @returns {string | null}
 */
function treeFile(treePath) {
    for (const root of roots()) {
        const abs = path.join(root.dir, treePath);
        if (fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) return abs;
    }
    return null;
}

/**
 * The text of a file of the tree; throws (naming the tree path) when no root has it.
 * @param {string} treePath
 */
function readTreeFile(treePath) {
    const abs = treeFile(treePath);
    if (!abs) throw new Error(`readTreeFile: no root holds ${treePath}`);
    return fs.readFileSync(abs, 'utf8');
}

/**
 * The absolute places a relative request written in a tree file may land on (extensions
 * and index files not yet tried): the same tree path in every root, core first. A request
 * that leaves the tree means the place beside the core root (as the resolver reads it).
 * @param {string} fromTreePath tree path of the file that holds the request
 * @param {string} spec the relative request
 * @returns {string[]}
 */
function requestPlaces(fromTreePath, spec) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromTreePath), spec));
    if (target === '..' || target.startsWith('../')) return [path.resolve(coreRoot, target)];
    return roots().map((root) => path.join(root.dir, target));
}

/**
 * The tree path of an absolute place, or the path relative to the core root (starting
 * with `..`) when it lies outside every root. Forward slashes.
 * @param {string} abs
 */
function treePathOf(abs) {
    return toTreePath(abs) ?? slash(path.relative(coreRoot, abs));
}

module.exports = { walkServerTree, treeJsFiles, treeFile, readTreeFile, requestPlaces, treePathOf, SKIP_DIRS };
