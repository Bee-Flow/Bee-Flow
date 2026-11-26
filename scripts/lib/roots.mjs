/**
 * The roots of a package's source tree, for repository scripts: server/ or agent-hub/ (the
 * core root) plus modules/<id>/server or modules/<id>/frontend (one root per module).
 *
 * A file keeps its path relative to its root (its TREE PATH) when it moves from the core
 * to a module, so a script that walks, globs or names files of a package goes through this
 * helper instead of `path.join(ROOT, 'server', ...)`, and keeps seeing the moved code:
 *
 *     rootsOf('server')                   [{ id: null, dir: <repo>/server }, { id: 'x', dir: <repo>/modules/x/server }]
 *     walkTree('agent-hub', { under: 'src' })   every file below src/ of every root
 *     resolveTreePath('server', 'core/llm/llmClient.js')   the root that has it, or null
 *     locate(abs)                         { pkg, treePath, moduleId } of a file of any root
 *
 * Where module roots are is decided by server/modules/roots/rootSet.cjs (moduleParents:
 * BEEFLOW_MODULE_ROOTS, else modules/ beside server/); this file reuses it, it does not
 * discover on its own. With no module directory every function gives exactly what a plain
 * walk of server/ or agent-hub/ gives. BEEFLOW_HIDE_MODULES does not apply here: a
 * repository script sees every file that is present.
 *
 * Zero dependencies: node:* only. createRoots({ repoRoot }) builds the same functions for
 * another checkout (a test fixture); the named exports are those of this repository.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { moduleParents } = require(path.join(REPO_ROOT, 'server', 'modules', 'roots', 'rootSet.cjs'));
const { ROOT_CONTROL_FILES } = require(path.join(REPO_ROOT, 'server', 'modules', 'roots', 'treeCheck.cjs'));

/** @typedef {'server' | 'agent-hub'} Pkg */
/** @typedef {{ id: string | null, dir: string }} Root  the core root has id null */
/** @typedef {{ treePath: string, abs: string, moduleId: string | null }} TreeFile */
/** @typedef {{ pkg: Pkg, treePath: string, moduleId: string | null }} Location */
/**
 * @typedef {object} WalkOptions
 * @property {(treePath: string) => boolean} [filter]  false prunes that file or directory
 * @property {string} [under]           tree path of a directory: walk only below it
 * @property {boolean} [controlFiles]   also yield the per-root control files (eslint.config.js, ...)
 */

/** Per package: the core directory, and the directory a module root has below modules/<id>/. */
export const PACKAGES = Object.freeze({
    server: Object.freeze({ core: 'server', inModule: 'server' }),
    'agent-hub': Object.freeze({ core: 'agent-hub', inModule: 'frontend' }),
});

/** Directory names never walked, at any depth. */
export const SKIP_DIRS = Object.freeze(['node_modules', 'coverage', 'dist', '.git']);

/** @param {string} p */
const slash = (p) => p.split(path.sep).join('/');

/**
 * @param {string} dir
 * @returns {fs.Dirent[]} sorted by name; none when unreadable
 */
function readSorted(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
        return [];
    }
}

/** @param {string} pkg */
function packageOf(pkg) {
    const spec = Object.hasOwn(PACKAGES, pkg) ? PACKAGES[/** @type {Pkg} */ (pkg)] : undefined;
    if (!spec) throw new Error(`roots: unknown package "${pkg}" (known: ${Object.keys(PACKAGES).join(', ')})`);
    return spec;
}

/**
 * The module roots of one package, by id; the first parent that has an id wins (as in
 * rootSet.cjs).
 * @param {string} repoRoot
 * @param {string} inModule
 * @returns {Root[]}
 */
function moduleRoots(repoRoot, inModule) {
    /** @type {Map<string, string>} */
    const byId = new Map();
    for (const parent of moduleParents(path.join(repoRoot, 'server'))) {
        for (const entry of readSorted(parent)) {
            const dir = path.join(parent, entry.name, inModule);
            if (!byId.has(entry.name) && fs.existsSync(dir)) byId.set(entry.name, dir);
        }
    }
    return [...byId.keys()].sort().map((id) => ({ id, dir: /** @type {string} */ (byId.get(id)) }));
}

/**
 * @param {fs.Dirent} entry
 * @param {string} rel tree path of the entry
 * @param {{ atRoot: boolean, otherRoots: Set<string>, abs: string, opts: WalkOptions }} ctx
 */
function skipped(entry, rel, ctx) {
    if (entry.isDirectory() && (SKIP_DIRS.includes(entry.name) || ctx.otherRoots.has(ctx.abs))) return true;
    if (ctx.atRoot && !ctx.opts.controlFiles && ROOT_CONTROL_FILES.has(entry.name)) return true;
    return ctx.opts.filter ? !ctx.opts.filter(rel) : false;
}

/**
 * @param {Root} root
 * @param {string} rel tree path of the directory being walked, '' for the root
 * @param {Set<string>} otherRoots directories of the other roots (a module parent may sit inside the core)
 * @param {WalkOptions} opts
 * @returns {Generator<TreeFile>}
 */
function* walkRoot(root, rel, otherRoots, opts) {
    for (const entry of readSorted(path.join(root.dir, rel))) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        const abs = path.join(root.dir, child);
        if (skipped(entry, child, { atRoot: rel === '', otherRoots, abs, opts })) continue;
        if (entry.isDirectory()) yield* walkRoot(root, child, otherRoots, opts);
        else yield { treePath: child, abs, moduleId: root.id };
    }
}

/**
 * The helper for one checkout.
 * @param {{ repoRoot?: string }} [options] repoRoot: the directory that holds server/ (default: this repository)
 */
export function createRoots({ repoRoot = REPO_ROOT } = {}) {
    const top = path.resolve(repoRoot);

    /**
     * @param {string} pkg 'server' | 'agent-hub'
     * @returns {Root[]} core first, then the modules by id
     */
    function rootsOf(pkg) {
        const spec = packageOf(pkg);
        return [{ id: null, dir: path.join(top, spec.core) }, ...moduleRoots(top, spec.inModule)];
    }

    /**
     * Every file of the package's tree, core root first, then the modules by id; within a
     * root sorted by name. Skips SKIP_DIRS at any depth and the per-root control files.
     * @param {string} pkg
     * @param {WalkOptions} [opts]
     * @returns {Generator<TreeFile>}
     */
    function* walkTree(pkg, opts = {}) {
        const roots = rootsOf(pkg);
        const under = opts.under ? opts.under.replace(/\/+$/, '') : '';
        for (const root of roots) {
            const others = new Set(roots.filter((r) => r !== root).map((r) => r.dir));
            if (under && !fs.existsSync(path.join(root.dir, under))) continue;
            yield* walkRoot(root, under, others, opts);
        }
    }

    /**
     * @param {string} pkg
     * @param {string} treePath
     * @returns {string | null} the absolute path in the first root (core first) that has it
     */
    function resolveTreePath(pkg, treePath) {
        for (const root of rootsOf(pkg)) {
            const abs = path.join(root.dir, treePath);
            if (fs.existsSync(abs)) return abs;
        }
        return null;
    }

    /**
     * The package, tree path and module of a file. Module roots are tried before the core
     * root: a module parent may sit inside it.
     * @param {string} abs absolute (or cwd-relative) path
     * @returns {Location | null} null outside every root
     */
    function locate(abs) {
        const file = path.resolve(abs);
        for (const pkg of /** @type {Pkg[]} */ (Object.keys(PACKAGES))) {
            for (const root of rootsOf(pkg).reverse()) {
                if (file === root.dir || file.startsWith(root.dir + path.sep)) {
                    return { pkg, treePath: slash(path.relative(root.dir, file)), moduleId: root.id };
                }
            }
        }
        return null;
    }

    /**
     * @param {string} abs
     * @returns {string} the path relative to the repository root, forward slashes
     */
    const toRepoPath = (abs) => slash(path.relative(top, path.resolve(abs)));
    /**
     * @param {string} rel a repository path, forward slashes
     * @returns {string} absolute
     */
    const fromRepoPath = (rel) => path.join(top, ...rel.split('/'));

    return { repoRoot: top, rootsOf, walkTree, resolveTreePath, locate, toRepoPath, fromRepoPath };
}

const DEFAULT = createRoots();

export const { repoRoot, rootsOf, walkTree, resolveTreePath, locate, toRepoPath, fromRepoPath } = DEFAULT;
