// @typecheck strict
/**
 * Data duties on a module's data: the core erases, exports, prunes or re-encrypts the data of a
 * first-party module on a user's or the platform's behalf (account and organisation erasure,
 * retention, the encryption backfill). Those duties must reach the data whenever this database
 * holds it, whether or not this edition loads the module, and must never report success for
 * data they could not reach. The rule (.claude/handoff/core-modules/phase1.4/data-duties-design.md):
 *
 *   module state   its file in the tree?   database holds its schema?   erasure, export   retention, re-encryption
 *   loaded         -                       -                            runs              runs
 *   failed         -                       -                            throws            throws
 *   absent         yes                     yes                          runs with the file, as before
 *   absent         yes                     no                           skipped           skipped
 *   absent         no                      no                           skipped           skipped
 *   absent         no                      yes                          REFUSES           skipped, one warning
 *
 * "Holds its schema" is read from the schema ledger (stores/lib/ddlLedger.js): every store init
 * is a unit `store:<tag>` in schema_migrations, and migrationOwners.json "storeUnits" records
 * which module owns each unit (core data, because the module may not be there to ask).
 *
 * The core's registry (core/featureModules.js) is read only when it is loaded, never loaded from
 * here: the platform layer does not require the core. Without it (a script that drives a store on
 * its own) no name can be registered, so the answer comes from the loader's state: the file of a
 * loaded module, null for an absent one. The answer never depends on which entry point the process
 * started from. lookupFeatureModule is that lookup on its own, for the stores' optional lookups
 * that are not data duties.
 *
 * A LOADED module's duty always reaches code: when the registry does not know the name, the
 * module's file is required from the tree, and a loaded module without that file is an error,
 * never a skipped duty.
 */

'use strict';

const fs = require('node:fs');
const { moduleStateOf, providerOf, assertProviderNotFailed, ModuleFailedError } = require('./moduleState');
const OWNERS = require('./migrationOwners.json');

/** @typedef {import('../../core/featureModules').FeatureModuleMap} FeatureModuleMap */
/** @typedef {'refuse' | 'warn'} WhenDataPresent */
/** @typedef {{ duty: string, whenDataPresent: WhenDataPresent }} DutyOptions */
/** @typedef {import('../../stores/lib/ddlLedgerTable').LedgerQuery} LedgerQuery */

/** How long "this database holds no schema of that module" is believed: a module can arrive later. */
const NEGATIVE_TTL_MS = 30_000;
const EXTENSIONS = ['.js', '.mts', '.cjs'];

/** Thrown when a duty cannot reach data this database holds, because the module's code is not here. */
class ModuleDataPresentError extends Error {
    /**
     * @param {string} moduleId
     * @param {string} duty
     * @param {{ unknown?: boolean }} [opts]  unknown: the ledger could not be read
     */
    constructor(moduleId, duty, opts = {}) {
        const what = opts.unknown ? 'this database may hold its data (the schema ledger could not be read)' : 'this database holds its data';
        super(`module "${moduleId}" is not installed but ${what}; refusing to ${duty}. Install the module or remove its data first.`);
        this.name = 'ModuleDataPresentError';
        this.code = 'MODULE_DATA_PRESENT';
        this.moduleId = moduleId;
        this.duty = duty;
    }
}

/**
 * A module's state in this edition, with the loader's verdict in: the loader decides it once per
 * process (cheap, it reads only the compositions), also in a process that never booted the server.
 * @param {string} moduleId
 */
function stateOf(moduleId) {
    require('./loader').load();
    return moduleStateOf(moduleId);
}

/**
 * The core registry's answer for `name`, exactly optionalFeatureModule(name) when the registry is
 * loaded. Without it nothing can be registered: the file of the loaded module that declares the
 * name, null when that module is absent, a ModuleFailedError when it failed.
 * @param {string} name
 * @returns {unknown}
 */
function registryLookup(name) {
    const { treePath } = require('../../moduleRoots.cjs');
    let file;
    try { file = require.resolve(treePath('core', 'featureModules.js')); } catch { file = null; }
    const registry = file ? require.cache[file] : undefined;
    if (registry?.loaded) return registry.exports.optionalFeatureModule(name);
    const owner = providerOf('featureModules', name) ?? (require('./loader').load(), providerOf('featureModules', name));
    assertProviderNotFailed('featureModules', name);
    return owner !== null && moduleStateOf(owner) === 'loaded' ? treeModule(name) : null;
}

/**
 * optionalFeatureModule(name) for the platform layer (stores/), which may not require the core:
 * the module, null when it is absent, a ModuleFailedError when it failed. For a lookup that is not
 * a data duty (an event, a sync notice); a data duty goes through moduleForDataDuty.
 * @template {keyof FeatureModuleMap} K
 * @param {K} name
 * @returns {FeatureModuleMap[K] | null}
 */
function lookupFeatureModule(name) {
    return /** @type {FeatureModuleMap[K] | null} */ (registryLookup(name));
}

/**
 * The module's file `name` when it is in the tree and not hidden (core mode), required; else null.
 * @param {string} name
 * @returns {unknown}
 */
function treeModule(name) {
    const { treePath, hiddenOwner } = require('../../moduleRoots.cjs');
    for (const ext of EXTENSIONS) {
        const abs = treePath(name + ext);
        if (fs.existsSync(abs) && !hiddenOwner(abs)) return require(abs);
    }
    return null;
}

/** The ledger's own query function, or null when this db facade keeps no ledger. */
function defaultLedgerQuery() {
    const db = require('../../db');
    return typeof db.ledgerQuery === 'function' ? /** @type {LedgerQuery} */ (db.ledgerQuery) : null;
}

/**
 * Is one of `units` recorded in the ledger? No ledger (no facade query, no table): no.
 * @param {string[]} units
 * @returns {Promise<boolean>}
 */
async function ledgerHolds(units) {
    const query = deps.ledgerQuery();
    if (!query) return false;
    // Two queries, so a missing table is never a failed statement (on one session it would abort a transaction).
    const table = await query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS present`);
    if (!table?.rows?.[0]?.present) return false;
    const hit = await query('SELECT 1 AS present FROM schema_migrations WHERE name = ANY($1::text[]) LIMIT 1', [units]);
    return (hit?.rows?.length ?? 0) > 0;
}

/** Overridable for the tests of this file (a ledger double, a tree double, a state double). */
const deps = {
    /** @type {(moduleId: string) => string} */
    state: stateOf,
    /** @type {(name: string) => unknown} */
    lookup: registryLookup,
    /** @type {(name: string) => unknown} */
    treeModule,
    /** @type {() => LedgerQuery | null} */
    ledgerQuery: defaultLedgerQuery,
    log: () => require('../../telemetry/log'),
    now: () => Date.now(),
};

/** @type {Map<string, true | number>} moduleId -> true (held) or the time "not held" was read */
const schemaCache = new Map();
/** @type {Set<string>} */
const warned = new Set();

/**
 * The ledger units of a module's stores (migrationOwners.json "storeUnits").
 * @param {string} moduleId
 * @returns {string[]}
 */
function unitsOf(moduleId) {
    /** @type {Record<string, string>} */
    const units = OWNERS.storeUnits;
    return Object.keys(units).filter((unit) => units[unit] === moduleId);
}

/**
 * Does this database hold a schema of that module? Throws when the ledger cannot be read.
 * @param {string} moduleId
 * @returns {Promise<boolean>}
 */
async function hasSchemaOf(moduleId) {
    const cached = schemaCache.get(moduleId);
    if (cached === true) return true;
    if (typeof cached === 'number' && deps.now() - cached < NEGATIVE_TTL_MS) return false;
    const units = unitsOf(moduleId);
    const held = units.length > 0 && await ledgerHolds(units);
    schemaCache.set(moduleId, held ? true : deps.now());
    return held;
}

/**
 * Data is (or may be) there and the module's code is not: refuse, or warn once and skip.
 * @param {string} moduleId
 * @param {DutyOptions} opts
 * @param {boolean} unknown  the ledger could not be read
 * @returns {null}
 */
function dataWithoutCode(moduleId, opts, unknown) {
    const err = new ModuleDataPresentError(moduleId, opts.duty, { unknown });
    if (opts.whenDataPresent === 'refuse') throw err;
    const key = `${moduleId}\n${opts.duty}`;
    if (!warned.has(key)) {
        warned.add(key);
        deps.log().warn(`[moduleData] ${err.message.replace('refusing to', 'skipping:')}`);
    }
    return null;
}

/**
 * The module file `name` for a data duty, or null when there is nothing to do (see the header).
 * @template {keyof FeatureModuleMap} K
 * @param {string} moduleId  the first-party module that owns the data, e.g. 'apps'
 * @param {K} name           a FeatureModuleMap name: the tree path of the module's file, without extension
 * @param {DutyOptions} opts duty: a few words for the message, e.g. "erase the apps of an account"
 * @returns {Promise<FeatureModuleMap[K] | null>}
 */
async function moduleForDataDuty(moduleId, name, opts) {
    if (opts?.whenDataPresent !== 'refuse' && opts?.whenDataPresent !== 'warn') {
        throw new TypeError(`moduleForDataDuty(${moduleId}, ${name}): whenDataPresent is 'refuse' or 'warn'`);
    }
    return /** @type {FeatureModuleMap[K] | null} */ (await dutyModule(moduleId, name, opts));
}

/**
 * A module that is not absent and whose name the registry did not answer: a failed module is an
 * error, a loaded one gives its file. Never null: a duty on a present module is not skipped.
 * @param {string} moduleId
 * @param {string} name
 * @param {string} state
 * @returns {unknown}
 */
function presentModule(moduleId, name, state) {
    if (state === 'failed') throw new ModuleFailedError(moduleId, 'featureModules', name, undefined);
    const file = deps.treeModule(name);
    if (!file) throw new Error(`moduleForDataDuty: module "${moduleId}" is loaded but has no file "${name}"`);
    return file;
}

/**
 * The rows of the header's table, for moduleForDataDuty. The registry is asked first: it holds a
 * name only for a loaded module (or a test's double), and throws for a failed one.
 * @param {string} moduleId
 * @param {string} name
 * @param {DutyOptions} opts
 * @returns {Promise<unknown>}
 */
async function dutyModule(moduleId, name, opts) {
    const found = deps.lookup(name);
    if (found) return found;
    const state = deps.state(moduleId);
    if (state !== 'absent') return presentModule(moduleId, name, state);
    let held;
    try {
        held = await hasSchemaOf(moduleId);
    } catch {
        const file = opts.whenDataPresent === 'refuse' ? deps.treeModule(name) : null;
        return file ?? dataWithoutCode(moduleId, opts, true);
    }
    if (!held) return null;
    return deps.treeModule(name) ?? dataWithoutCode(moduleId, opts, false);
}

/**
 * A module's file by its tree path (without extension), required, when it is in the tree and not
 * hidden; else null. For a duty on data that lives in the core's own tables (the projects of an
 * account), where the ledger cannot say whether the module ever wrote any.
 * @param {string} name
 * @returns {unknown}
 */
function moduleFileInTree(name) {
    return deps.treeModule(name);
}

/**
 * Test seam: replace some sources, and forget every cached answer and warning.
 * @param {Partial<typeof deps>} [next]
 */
function _setModuleDataDepsForTests(next = {}) {
    Object.assign(deps, next);
    schemaCache.clear();
    warned.clear();
}

/** Test seam: the default sources back, caches cleared. */
function _resetModuleDataForTests() {
    _setModuleDataDepsForTests({
        state: stateOf, lookup: registryLookup, treeModule, ledgerQuery: defaultLedgerQuery,
        log: () => require('../../telemetry/log'), now: () => Date.now(),
    });
}

module.exports = {
    ModuleDataPresentError,
    moduleForDataDuty,
    hasSchemaOf,
    unitsOf,
    lookupFeatureModule,
    moduleFileInTree,
    _setModuleDataDepsForTests,
    _resetModuleDataForTests,
};
