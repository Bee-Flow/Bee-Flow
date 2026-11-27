// @typecheck strict
/**
 * The edition rule of the first-party loader (modules/firstParty/loader.js): which modules an
 * edition (BEEFLOW_EDITION / BEEFLOW_MODULES, read by modules/catalog.js) makes available, and
 * the log lines that say so. With neither variable set every module is available.
 *
 * A module is available when the edition lists it, or when it has no row of its own in the
 * catalog (no switch on the admin Modules page) and an available module requires it, directly or
 * through other such modules. A module with a catalog row is available only when listed, so its
 * gates (requireModule) and capability projection, which read the catalog, agree with the loader.
 * `uses` never pulls a module in. Dependency-free: plain functions over literal objects.
 */

'use strict';

/** @typedef {import('./contract').Log} Log */

/**
 * @typedef {{ listed: (id: string) => boolean, hasOwnSwitch: (id: string) => boolean }} EditionRule
 *   listed: the edition makes this id available on its own (BEEFLOW_MODULES names it, or no edition is in force)
 *   hasOwnSwitch: the id has a row of its own in the catalog (modules/catalog.js)
 */

/**
 * The modules this edition makes available. An id is available when the edition lists it, or
 * when it has no switch of its own and an available module requires it (directly or through
 * other such ids). `uses` never pulls a module in. requiresOf is asked for available ids only,
 * the listed ones first and in the order of `ids`.
 * @param {readonly string[]} ids every module id of the tree
 * @param {(id: string) => readonly string[]} requiresOf
 * @param {EditionRule} rule
 * @returns {{ available: Set<string>, cameWith: Map<string, string> }} cameWith: pulled-in id -> the module that required it
 */
function availableIds(ids, requiresOf, rule) {
    const known = new Set(ids);
    const queue = ids.filter((id) => rule.listed(id));
    const available = new Set(queue);
    /** @type {Map<string, string>} */
    const cameWith = new Map();
    for (let i = 0; i < queue.length; i += 1) {
        const id = /** @type {string} */ (queue[i]);
        for (const r of requiresOf(id)) {
            if (!known.has(r) || available.has(r) || rule.hasOwnSwitch(r)) continue;
            available.add(r);
            cameWith.set(r, id);
            queue.push(r);
        }
    }
    return { available, cameWith };
}

/**
 * The ids BEEFLOW_MODULES names that are neither a module of the tree nor a catalog row.
 * @param {readonly string[]} named
 * @param {readonly string[]} ids
 * @param {(id: string) => boolean} hasOwnSwitch
 */
function unknownListed(named, ids, hasOwnSwitch) {
    return named.filter((n) => !ids.includes(n) && !hasOwnSwitch(n));
}

/**
 * The one line that says what an edition in force loaded and left out, e.g.
 * `[modules] edition: core + automation, datatables (comes with automation); left out: apps, cowork (it requires ...)`.
 * A module the edition made available that is absent all the same carries its reason.
 * @param {Array<{ id: string, state: string, detail?: string }>} mods by id
 * @param {{ available: Set<string>, cameWith: Map<string, string> }} picked
 */
function editionLine(mods, picked) {
    const loaded = mods.filter((m) => m.state === 'loaded').map((m) => {
        const by = picked.cameWith.get(m.id);
        return by ? `${m.id} (comes with ${by})` : m.id;
    });
    const out = mods.filter((m) => m.state === 'absent').map((m) => (picked.available.has(m.id) ? `${m.id} (${m.detail})` : m.id));
    return `[modules] edition: core${loaded.length ? ` + ${loaded.join(', ')}` : ''}; left out: ${out.length ? out.join(', ') : 'none'}`;
}

/**
 * @typedef {{ isModuleAvailable: (id: string) => boolean, availableByEdition?: (id: string) => boolean,
 *   getModule?: (id: string) => object | null, editionChoice?: () => { inForce: boolean, named: string[] } }} CatalogSeam
 *   the parts of modules/catalog.js the loader reads; a test double may give isModuleAvailable alone,
 *   and then every id counts as having its own switch (nothing comes along)
 */

/**
 * The edition rule of a catalog.
 * @param {CatalogSeam} catalog
 * @returns {EditionRule & { inForce: boolean, named: string[] }}
 */
function editionRule(catalog) {
    const choice = catalog.editionChoice ? catalog.editionChoice() : { inForce: false, named: [] };
    const listed = catalog.availableByEdition || catalog.isModuleAvailable;
    const getModule = catalog.getModule;
    return {
        listed: (id) => listed(id),
        hasOwnSwitch: getModule ? (id) => getModule(id) !== null : () => true,
        inForce: choice.inForce,
        named: choice.named,
    };
}

/**
 * Log what an edition in force did: one warning naming the unknown ids of BEEFLOW_MODULES, and
 * the edition line (editionLine). Nothing when no edition is in force.
 * @param {Log} log
 * @param {ReturnType<typeof editionRule>} rule
 * @param {{ available: Set<string>, cameWith: Map<string, string> }} picked
 * @param {Array<{ id: string, state: string, detail?: string }>} mods every module of the tree, by id
 */
function reportEdition(log, rule, picked, mods) {
    if (!rule.inForce) return;
    const ids = mods.map((m) => m.id);
    const unknown = unknownListed(rule.named, ids, rule.hasOwnSwitch);
    if (unknown.length) log.warn(`[modules] BEEFLOW_MODULES names unknown module(s) ${unknown.join(', ')}; ignored. Known: ${ids.join(', ')}`);
    log.info(editionLine(mods, picked));
}

module.exports = { availableIds, unknownListed, editionLine, editionRule, reportEdition };
