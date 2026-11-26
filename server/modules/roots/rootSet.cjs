// @typecheck strict
/**
 * The roots of the source tree, and which files count as absent.
 *
 * The core root is server/. A module root is `<parent>/<id>/server`; the parents come from
 * BEEFLOW_MODULE_ROOTS (separated like PATH; the empty string means "no modules"), else
 * `modules/` beside server/ when it exists. See server/moduleRoots.cjs for the whole picture.
 *
 * Loaded by a `--require` preload in every process and thread: node:* only, no logging,
 * and nothing here may require another file of the tree.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** @typedef {{ id: string | null, dir: string }} Root  the core root has id null */

const CORE_ROOT = path.resolve(__dirname, '..', '..');

/** The directories that hold `<id>/server`, from the environment or the default place. */
function moduleParents() {
    const fromEnv = process.env.BEEFLOW_MODULE_ROOTS;
    if (fromEnv !== undefined) return fromEnv.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
    return [path.resolve(CORE_ROOT, '..', 'modules')];
}

/**
 * A directory's entries, or none when it cannot be read.
 * @param {string} dir
 * @returns {fs.Dirent[]}
 */
function readDir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

/** @returns {Root[]} the module roots, by id; the first parent that has an id wins */
function discoverModuleRoots() {
    /** @type {Map<string, string>} */
    const byId = new Map();
    for (const parent of moduleParents()) {
        for (const entry of readDir(parent)) {
            const dir = path.join(parent, entry.name, 'server');
            if (!byId.has(entry.name) && fs.existsSync(dir)) byId.set(entry.name, dir);
        }
    }
    return [...byId.keys()].sort().map((id) => ({ id, dir: /** @type {string} */ (byId.get(id)) }));
}

/** @type {Root[]} core first, then the modules by id */
const ROOTS = [{ id: null, dir: CORE_ROOT }, ...discoverModuleRoots()];

/**
 * The root a file lies in. Module roots are tried first: a module parent may sit inside
 * the core root (the data directory does).
 * @param {string} file absolute path
 * @returns {Root | null}
 */
function rootOf(file) {
    for (let i = ROOTS.length - 1; i >= 0; i--) {
        const root = /** @type {Root} */ (ROOTS[i]);
        if (file === root.dir || file.startsWith(root.dir + path.sep)) return root;
    }
    return null;
}

/**
 * @param {string} file absolute path
 * @returns {string | null} its tree path, with forward slashes; null outside every root
 */
function toTreePath(file) {
    const root = rootOf(file);
    return root ? path.relative(root.dir, file).split(path.sep).join('/') : null;
}

// ── Core mode: the files of hidden modules count as absent ───────────────────
//
// BEEFLOW_HIDE_MODULES=all (or a list of module ids), for development and CI only. A file
// in a module root belongs to that module. A file that still sits in the core root belongs
// to whoever the ownership map says (scripts/module-map.mjs, present in a checkout and not
// in an image), so the core can be run and tested alone before a single file has moved.

const HIDE = (process.env.BEEFLOW_HIDE_MODULES || '').split(',').map((s) => s.trim()).filter(Boolean);
const HIDE_ALL = HIDE.includes('all');
/** @type {((treePath: string) => string | null) | null | undefined} */
let coreOwnerOf;

/**
 * @param {string} rel tree path of a file in the core root
 * @returns {string | null} the module that owns it, null for the core
 */
function ownerInCoreRoot(rel) {
    if (coreOwnerOf === undefined) {
        coreOwnerOf = null;
        const lib = path.resolve(CORE_ROOT, '..', 'scripts', 'module-map.mjs');
        if (fs.existsSync(lib)) {
            const map = require(lib).loadModuleMap();
            coreOwnerOf = (/** @type {string} */ p) => map.ownerOf('server', p);
        }
    }
    return coreOwnerOf ? coreOwnerOf(rel) : null;
}

/** @type {Map<string, string | null>} file -> the hidden module that owns it, or null */
const hiddenCache = new Map();

/**
 * @param {string} file absolute path
 * @returns {string | null} the id of the hidden module this file belongs to
 */
function hiddenOwner(file) {
    if (HIDE.length === 0 || file.includes(`${path.sep}node_modules${path.sep}`)) return null;
    const cached = hiddenCache.get(file);
    if (cached !== undefined) return cached;
    const root = rootOf(file);
    const owner = !root ? null : root.id ?? ownerInCoreRoot(/** @type {string} */ (toTreePath(file)));
    const hidden = owner && (HIDE_ALL || HIDE.includes(owner)) ? owner : null;
    hiddenCache.set(file, hidden);
    return hidden;
}

/**
 * Is a whole module root hidden?
 * @param {Root} root
 */
function rootHidden(root) {
    return root.id !== null && (HIDE_ALL || HIDE.includes(root.id));
}

module.exports = {
    CORE_ROOT,
    ROOTS,
    readDir,
    rootOf,
    toTreePath,
    hiddenOwner,
    rootHidden,
    /** Is anything hidden at all? */
    hiding: HIDE.length > 0,
};
