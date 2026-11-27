// @typecheck strict
/**
 * Which recorded routes belong to a first-party module that is not loaded in this process.
 *
 * auth/routes.contract.json records every route of the whole product. With a module absent
 * (core mode, BEEFLOW_HIDE_MODULES=all; or an edition that leaves it out) its routes are not
 * mounted, and a test that holds the router to that file must tell "not mounted because its
 * module is not here" from "gone". A route is a module's when the file that registers it is
 * owned by that module (scripts/module-map.json, as modules/roots/rootSet.cjs reads it), and
 * the module is absent when the loader (modules/firstParty/loader.js) did not load it. A route
 * whose file is the core's, or whose module is loaded or failed, is never excused.
 *
 * The file of a route comes from the static route sweep (testUtils/routeSurfaceSweep.js) over
 * the mount rows of EVERY module, hidden or not: the sweep reads source text, and a hidden
 * module's routers are still in the tree. A route the sweep does not list (a helper registers
 * it on a router the sweep does not follow) has the owner of the listed routes nearest to its
 * path, when those all have one owner; else it is not excused.
 *
 *   const absent = routesOfAbsentModules(ids);   // Map<route id, module id>
 */

'use strict';

const fs = require('node:fs');
const { parseSurface, stripComments } = require('./routeSurfaceSweep');
const { rowsOf } = require('./mountRowsText');
const { treeFile, walkServerTree } = require('./serverTree');
const { repoPath } = require('../moduleRoots.cjs');

/** The mounts part files of every root, the hidden modules' included, by name. */
function everyMountPart() {
    return walkServerTree({ under: 'firstParty', filter: (_rel, e) => e.isDirectory() || e.name.endsWith('.mounts.js') })
        .sort((a, b) => a.treePath.localeCompare(b.treePath))
        .map((f) => ({ file: f.treePath, text: fs.readFileSync(f.abs, 'utf8') }));
}

/** @param {string} rel */
function readSource(rel) {
    try {
        const p = treeFile(rel);
        return p ? fs.readFileSync(p, 'utf8') : null;
    } catch (_) { return null; }
}

/** @param {string} p @returns {string[]} */
const segments = (p) => p.split('/').filter(Boolean);

/**
 * The number of leading path segments two paths share.
 * @param {string[]} a
 * @param {string[]} b
 */
function shared(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
    return n;
}

/**
 * The owner of the routes the sweep lists nearest to `routePath` (the most leading segments in
 * common, at least the two of a mount such as `/api/x`), when they all have one owner; else
 * undefined. For a route the sweep cannot list (registered by a helper it does not follow).
 * @param {string} routePath
 * @param {Array<{ segs: string[], owner: string | null }>} listed
 * @returns {string | null | undefined}
 */
function nearestOwner(routePath, listed) {
    const segs = segments(routePath);
    let best = 1;
    /** @type {Set<string | null>} */
    let owners = new Set();
    for (const r of listed) {
        const n = shared(segs, r.segs);
        if (n > best) { best = n; owners = new Set([r.owner]); } else if (n === best && best > 1) owners.add(r.owner);
    }
    return owners.size === 1 ? [...owners][0] : undefined;
}

/**
 * The module that owns the file registering each route of the whole tree (null: the core), as
 * the sweep reads it; undefined when that cannot be told.
 * @param {(treePath: string) => string | null} owner
 * @returns {(id: string) => string | null | undefined}
 */
function routeOwners(owner) {
    const parts = everyMountPart();
    const surface = parseSurface(readSource, 'index.js', { mountParts: () => parts });
    /** @type {Map<string, string | null>} */
    const byId = new Map();
    for (const r of surface.routes) if (!byId.has(`${r.method} ${r.path}`)) byId.set(`${r.method} ${r.path}`, owner(r.file));
    const listed = surface.routes.filter((r) => !r.dynamic).map((r) => ({ segs: segments(r.path), owner: owner(r.file) }));
    // A module's main mount rows by path, the longest first: a router the sweep cannot read at all.
    const mounts = parts.flatMap(({ file, text }) => rowsOf(stripComments(text), file))
        .filter((r) => r.slot === 'main' && r.path)
        // The row's path is its source text, a string literal with its quotes.
        .map((r) => ({ segs: segments(String(r.path).slice(1, -1)), owner: owner(r.file) }))
        .sort((a, b) => b.segs.length - a.segs.length);
    return (id) => {
        if (byId.has(id)) return byId.get(id);
        const routePath = id.slice(id.indexOf(' ') + 1);
        const near = nearestOwner(routePath, listed);
        if (near !== undefined) return near;
        const segs = segments(routePath);
        return mounts.find((m) => shared(segs, m.segs) === m.segs.length)?.owner;
    };
}

/** @returns {(treePath: string) => string | null} the module that owns a server file, null for the core */
function ownerOf() {
    const map = require(repoPath('scripts', 'module-map.mjs')).loadModuleMap();
    return (treePath) => map.ownerOf('server', treePath);
}

/** @returns {Set<string>} the modules the loader loaded or saw fail in this process */
function presentModules() {
    const loader = require('../modules/firstParty/loader');
    return new Set(loader.load().filter((m) => m.state !== 'absent').map((m) => m.id));
}

/**
 * The routes among `ids` whose registering file belongs to a module that is not loaded.
 * @param {string[]} ids route ids, 'METHOD /path'
 * @returns {Map<string, string>} route id -> the absent module
 */
function routesOfAbsentModules(ids) {
    /** @type {Map<string, string>} */
    const out = new Map();
    if (!ids.length) return out;
    const present = presentModules();
    const moduleOf = routeOwners(ownerOf());
    for (const id of ids) {
        const moduleId = moduleOf(id);
        if (moduleId && !present.has(moduleId)) out.set(id, moduleId);
    }
    return out;
}

module.exports = { routesOfAbsentModules };
