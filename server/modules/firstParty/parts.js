// @typecheck strict
/**
 * The part files of a first-party composition, merged into it.
 *
 * A composition (firstParty/<id>.js, see modules/firstParty/contract.js) is short: its id,
 * requires and uses, and then `withParts(...)`, which adds whatever the part files beside it
 * export. One part per kind of composition, so each later extraction writes one file:
 *
 *     firstParty/<id>.mounts.js    mounts, aiMounts
 *     firstParty/<id>.register.js  register, provides
 *     firstParty/<id>.jobs.js      jobs, afterListen, drain, close
 *     firstParty/<id>.stores.js    stores, migrations, nlTranslations
 *
 * A part is looked up through the tree (moduleRoots.cjs treePath), so it is found wherever the
 * module lives. A part file that does not exist (or that core mode hides) yields nothing; a part
 * file that exists and throws while it loads throws here, so the loader marks the module failed
 * instead of loading half of it. A part may only export the keys of its kind, and no key twice.
 */

'use strict';

const fs = require('node:fs');

/** @typedef {import('./contract').PartName} PartName */
/** @typedef {import('./contract').ModuleComposition} ModuleComposition */
/**
 * @typedef {{ find?: (name: string) => string | null, load?: (file: string) => unknown }} PartDeps
 *   find: the absolute path of firstParty/<name>.js, or null when it is absent; load: require
 */

/** @type {Readonly<Record<PartName, readonly string[]>>} */
const PART_KEYS = Object.freeze({
    mounts: Object.freeze(['mounts', 'aiMounts']),
    register: Object.freeze(['register', 'provides']),
    jobs: Object.freeze(['jobs', 'afterListen', 'drain', 'close']),
    stores: Object.freeze(['stores', 'migrations', 'nlTranslations']),
});

/** @type {readonly PartName[]} */
const PART_NAMES = Object.freeze(/** @type {PartName[]} */ (Object.keys(PART_KEYS)));

/**
 * @param {string} name file name without .js, e.g. 'apps.mounts'
 * @returns {string | null}
 */
function findInTree(name) {
    const roots = require('../../moduleRoots.cjs');
    const abs = roots.treePath('firstParty', `${name}.js`);
    return fs.existsSync(abs) && !roots.hiddenOwner(abs) ? abs : null;
}

/**
 * The exports of firstParty/<name>.js, or null when that file is absent.
 * @param {string} name
 * @param {PartDeps} [deps]
 * @returns {unknown}
 */
function optionalPart(name, deps = {}) {
    const file = (deps.find || findInTree)(name);
    if (file === null) return null;
    return (deps.load || require)(file);
}

/**
 * Add one part's keys to the composition being built.
 * @param {Record<string, unknown>} out
 * @param {string} id
 * @param {PartName} part
 * @param {unknown} exported
 */
function mergePart(out, id, part, exported) {
    const where = `firstParty/${id}.${part}.js`;
    if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) {
        throw new TypeError(`${where} must export an object`);
    }
    for (const [key, value] of Object.entries(exported)) {
        if (!PART_KEYS[part].includes(key)) {
            throw new Error(`${where} exports "${key}"; a ${part} part holds ${PART_KEYS[part].join(', ')}`);
        }
        if (key in out) throw new Error(`${where} exports "${key}", which the composition of "${id}" already has`);
        out[key] = value;
    }
}

/**
 * The composition `base` with the keys of every part file of its module that exists.
 * @param {{ id: string, requires?: string[], uses?: string[] }} base
 * @param {PartDeps} [deps]
 * @returns {ModuleComposition}
 */
function withParts(base, deps = {}) {
    /** @type {Record<string, unknown>} */
    const out = { ...base };
    for (const part of PART_NAMES) {
        const exported = optionalPart(`${base.id}.${part}`, deps);
        if (exported !== null) mergePart(out, base.id, part, exported);
    }
    return /** @type {ModuleComposition} */ (/** @type {unknown} */ (out));
}

module.exports = { withParts, optionalPart, PART_KEYS, PART_NAMES };
