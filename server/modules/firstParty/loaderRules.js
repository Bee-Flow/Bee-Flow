// @typecheck strict
/**
 * The rules of the first-party loader (modules/firstParty/loader.js) that need no state:
 * what a composition must look like, which compositions conflict, the requires order, and
 * how contributed rows are sorted by the core's order index.
 *
 * Also the two steps that need no state either: starting one job row, and one shutdown hook
 * bounded by a time-out. Dependency-free (node:* and the contract types only), so every rule
 * is a plain function a test can call with literal objects.
 */

'use strict';

/** @typedef {import('./contract').ModuleComposition} ModuleComposition */
/** @typedef {import('./contract').MountSlot} MountSlot */
/** @typedef {import('./contract').StartupPhase} StartupPhase */
/** @typedef {import('./contract').JobRow} JobRow */
/** @typedef {import('./contract').Log} Log */

/** @type {readonly MountSlot[]} */
const SLOTS = Object.freeze(/** @type {MountSlot[]} */ (['static', 'early', 'main', 'fallback']));

/**
 * The function names of boot/startupTasks.js STARTUP_PHASES, in that order. Held equal to the
 * real list by loaderRules.test.js; a list here so that the loader need not load boot/.
 * @type {readonly StartupPhase[]}
 */
const STARTUP_PHASE_NAMES = Object.freeze(/** @type {StartupPhase[]} */ ([
    'startConfigInvalidationListener', 'startBootProbes', 'startLicenseAndModuleRuntime', 'runOneShotTasks',
    'startDunningAndTrialSchedulers', 'startPlanCapDriftAudit', 'startSeatSync', 'startPaygDrain', 'startLateWarmups',
    'startRetentionAndComplianceJobs', 'seedSystemAgentsAtBoot', 'startModuleSchedulers', 'startRunnersAndFeeds',
    'startSupportAndSyncJobs', 'startPruneSchedulers',
]));

const PROVIDE_KINDS = Object.freeze(['featureModules', 'integrationClients', 'runnerPorts']);
const FUNCTION_KEYS = Object.freeze(['register', 'afterListen', 'drain', 'close']);
const NAME_LIST_KEYS = Object.freeze(['requires', 'uses', 'capabilities', 'migrations', 'nlTranslations']);
const KNOWN_KEYS = new Set(['id', 'provides', 'mounts', 'aiMounts', 'jobs', 'stores', ...FUNCTION_KEYS, ...NAME_LIST_KEYS]);

/** @param {unknown} v */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isNameList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '');
/** @param {unknown} v */
const isOptionalFn = (v) => v === undefined || typeof v === 'function';

/**
 * @param {string} id
 * @param {unknown} key
 * @returns {string | null}
 */
function keyProblem(id, key) {
    if (typeof key !== 'string' || !key.startsWith(`${id}:`) || key.length === id.length + 1) {
        return `key ${JSON.stringify(key)} is not "${id}:<name>"`;
    }
    return null;
}

/**
 * @param {Record<string, any>} row
 * @param {boolean} ai an aiMounts row (no slot)
 */
function mountRowProblem(row, ai) {
    if (!ai && !SLOTS.includes(row.slot)) return `slot ${JSON.stringify(row.slot)} is not one of ${SLOTS.join(', ')}`;
    if (row.path !== null && (typeof row.path !== 'string' || row.path === '')) return 'path is a non-empty string or null';
    if (typeof row.handlers !== 'function') return 'handlers is a function of the gates';
    if (!isOptionalFn(row.when) || !isOptionalFn(row.onMount)) return 'when and onMount are functions';
    return null;
}

/** @param {Record<string, any>} row */
function jobRowProblem(row) {
    if (!STARTUP_PHASE_NAMES.includes(row.phase)) return `phase ${JSON.stringify(row.phase)} is not a startup phase`;
    if (typeof row.start !== 'function') return 'start is a function';
    if (row.label !== undefined && typeof row.label !== 'string') return 'label is a string';
    if (row.failText !== undefined && typeof row.failText !== 'string') return 'failText is a string';
    return null;
}

/**
 * @param {string} list mounts | aiMounts | jobs
 * @param {string} id
 * @param {unknown} rows
 * @returns {string | null}
 */
function keyedRowsProblem(list, id, rows) {
    if (rows === undefined) return null;
    if (!Array.isArray(rows)) return `${list} is a list`;
    for (const [i, row] of rows.entries()) {
        const problem = !isObject(row) ? 'is not an object'
            : keyProblem(id, row.key) || (list === 'jobs' ? jobRowProblem(row) : mountRowProblem(row, list === 'aiMounts'));
        if (problem) return `${list}[${i}]: ${problem}`;
    }
    return null;
}

/** @param {unknown} rows */
function storesProblem(rows) {
    if (rows === undefined) return null;
    if (!Array.isArray(rows)) return 'stores is a list';
    const bad = rows.findIndex((r) => !isObject(r) || typeof r.name !== 'string' || !r.name || typeof r.file !== 'string' || !r.file);
    return bad === -1 ? null : `stores[${bad}]: a store row is { name, file }`;
}

/** @param {unknown} provides */
function providesProblem(provides) {
    if (provides === undefined) return null;
    if (!isObject(provides)) return 'provides is an object';
    const p = /** @type {Record<string, unknown>} */ (provides);
    const unknown = Object.keys(p).find((k) => !PROVIDE_KINDS.includes(k));
    if (unknown) return `provides.${unknown} is not one of ${PROVIDE_KINDS.join(', ')}`;
    const bad = PROVIDE_KINDS.find((k) => p[k] !== undefined && !isNameList(p[k]));
    return bad ? `provides.${bad} is a list of names` : null;
}

/**
 * The pure-data provides file of a module: firstParty/<id>.provides.json, beside its composition.
 * The loader declares it before it requires any of the module's code (modules/firstParty/loader.js).
 */
const PROVIDES_FILE = /^([A-Za-z][A-Za-z0-9_]*)\.provides\.json$/;

/**
 * The provides files in a listing of firstParty/: module id -> absolute path.
 * @param {Array<{ name: string, abs: string }>} listing
 * @returns {Map<string, string>}
 */
function providesFilesOf(listing) {
    /** @type {Map<string, string>} */
    const out = new Map();
    for (const { name, abs } of listing) {
        const m = PROVIDES_FILE.exec(name);
        if (m) out.set(/** @type {string} */ (m[1]), abs);
    }
    return out;
}

/**
 * Read a provides file: its contents, or what is wrong with it.
 * @param {(file: string) => unknown} load require
 * @param {string} file
 * @returns {{ provides: import('./moduleState').Provides } | { problem: string }}
 */
function readProvidesFile(load, file) {
    /** @type {unknown} */
    let provides;
    try { provides = load(file); } catch (err) { return { problem: `could not be read: ${messageOf(err)}` }; }
    const problem = provides === undefined ? 'is empty' : providesProblem(provides);
    return problem ? { problem } : { provides: /** @type {import('./moduleState').Provides} */ (provides) };
}

/**
 * Do two provides declare the same names (per kind, in any order; a missing kind is an empty list)?
 * @param {import('./moduleState').Provides} a
 * @param {import('./moduleState').Provides} b
 */
function sameProvides(a, b) {
    const names = (/** @type {Record<string, unknown>} */ p, /** @type {string} */ k) => JSON.stringify([.../** @type {string[]} */ (p[k] || [])].sort());
    return PROVIDE_KINDS.every((k) => names(a, k) === names(b, k));
}

/** @param {Record<string, unknown>} comp */
function plainKeysProblem(comp) {
    const unknown = Object.keys(comp).find((k) => !KNOWN_KEYS.has(k));
    if (unknown) return `unknown key "${unknown}"`;
    const list = NAME_LIST_KEYS.find((k) => comp[k] !== undefined && !isNameList(comp[k]));
    if (list) return `${list} is a list of names`;
    const fn = FUNCTION_KEYS.find((k) => !isOptionalFn(comp[k]));
    return fn ? `${fn} is a function` : null;
}

/**
 * What is wrong with a composition on its own, or null.
 * @param {unknown} comp what firstParty/<fileId>.js exported
 * @param {string} fileId the file name without .js
 * @returns {string | null}
 */
function compositionProblem(comp, fileId) {
    if (!isObject(comp)) return 'the composition does not export an object';
    const c = /** @type {Record<string, unknown>} */ (comp);
    if (c.id !== fileId) return `its id ${JSON.stringify(c.id)} is not the file name "${fileId}"`;
    if ((/** @type {string[]} */ (c.requires) || []).includes(fileId)) return 'it requires itself';
    return plainKeysProblem(c) || providesProblem(c.provides) || storesProblem(c.stores)
        || keyedRowsProblem('mounts', fileId, c.mounts) || keyedRowsProblem('aiMounts', fileId, c.aiMounts)
        || keyedRowsProblem('jobs', fileId, c.jobs);
}

/**
 * The row keys (mounts, aiMounts and jobs together) that a composition claims after an
 * earlier one already did: key -> the earlier module.
 * @param {ModuleComposition[]} comps in load order
 * @returns {Map<string, { key: string, owner: string }>} module id -> its first clashing key
 */
function duplicateKeys(comps) {
    /** @type {Map<string, string>} */
    const seen = new Map();
    /** @type {Map<string, { key: string, owner: string }>} */
    const clashes = new Map();
    for (const comp of comps) {
        const keys = [...(comp.mounts || []), ...(comp.aiMounts || []), ...(comp.jobs || [])].map((r) => r.key);
        for (const key of keys) {
            const owner = seen.get(key);
            if (owner !== undefined && !clashes.has(comp.id)) clashes.set(comp.id, { key, owner });
            if (owner === undefined) seen.set(key, comp.id);
        }
    }
    return clashes;
}

/**
 * What its requires make of a module: loaded when each of them is; absent when one is not
 * available in this edition (the loader keeps an 'absent' entry for those only); failed when
 * one failed or has no composition at all.
 * @param {readonly string[]} requires
 * @param {(id: string) => string | undefined} stateOf
 * @returns {{ state: 'loaded' } | { state: 'absent' | 'failed', detail: string }}
 */
function requiresVerdict(requires, stateOf) {
    const missing = requires.find((r) => stateOf(r) !== 'loaded');
    if (missing === undefined) return { state: 'loaded' };
    const blocker = stateOf(missing);
    if (blocker === 'absent') return { state: 'absent', detail: `it requires "${missing}", which is not available in this edition` };
    return { state: 'failed', detail: `it requires "${missing}", which ${blocker === 'failed' ? 'failed' : 'is absent'}` };
}

/**
 * The ids in requires order (a module after everything it requires; ties by id), and the ids
 * that sit on a requires cycle. A require of an id that is not in the list is ignored here.
 * @param {Map<string, string[]>} requiresOf id -> requires
 * @returns {{ order: string[], cyclic: string[] }}
 */
function requiresOrder(requiresOf) {
    /** @type {string[]} */
    const order = [];
    const done = new Set();
    let remaining = [...requiresOf.keys()].sort();
    for (;;) {
        const ready = remaining.filter((id) => (requiresOf.get(id) || []).every((r) => done.has(r) || !requiresOf.has(r)));
        if (ready.length === 0) break;
        for (const id of ready) { order.push(id); done.add(id); }
        remaining = remaining.filter((id) => !done.has(id));
    }
    return { order, cyclic: remaining };
}

/**
 * Sort contributed rows by the core's order index: a listed name by its position, then the
 * unlisted ones by module id and then by their order inside the module.
 * @template T
 * @param {Array<{ moduleId: string, index: number, name: string, row: T }>} items
 * @param {readonly string[]} listed
 * @returns {T[]}
 */
function orderRows(items, listed) {
    const pos = new Map(listed.map((name, i) => [name, i]));
    const rank = (/** @type {string} */ name) => pos.get(name) ?? Number.POSITIVE_INFINITY;
    return [...items].sort((a, b) => (rank(a.name) - rank(b.name)) || (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0) || (a.index - b.index))
        .map((item) => item.row);
}

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Start one job row the way boot/startupJobs.js starts a job: a throw is logged as
 * '[Server] <label> <failText>:', a rejected promise as '[Server] <label> start error:'.
 * @param {Log} log
 * @param {JobRow} row
 * @param {unknown} ctx
 */
function startJob(log, row, ctx) {
    const label = row.label ?? row.key;
    try {
        const result = /** @type {{ then?: unknown } | null | undefined} */ (row.start(ctx));
        if (result && typeof result.then === 'function') {
            /** @type {Promise<unknown>} */ (result).then(undefined, (/** @type {unknown} */ err) => log.warn(`[Server] ${label} start error:`, messageOf(err)));
        }
    } catch (err) {
        log.warn(`[Server] ${label} ${row.failText ?? 'load failed'}:`, messageOf(err));
    }
}

/**
 * Run fn({ timeoutMs }) and wait at most timeoutMs; never rejects. A throw, a rejection or the
 * time-out is logged under `what`.
 * @param {Log} log
 * @param {string} what e.g. 'module apps drain'
 * @param {(opts: { timeoutMs: number }) => Promise<void>} fn
 * @param {number} timeoutMs
 */
async function runBounded(log, what, fn, timeoutMs) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    try {
        const outcome = await Promise.race([Promise.resolve().then(() => fn({ timeoutMs })).then(() => 'done'), timeout]);
        if (outcome === 'timeout') log.warn(`[Server] ${what} did not finish within ${timeoutMs} ms`);
    } catch (err) {
        log.warn(`[Server] ${what} failed:`, messageOf(err));
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    SLOTS, STARTUP_PHASE_NAMES, PROVIDES_FILE, providesFilesOf, compositionProblem, readProvidesFile, sameProvides, duplicateKeys, requiresOrder, requiresVerdict, orderRows,
    startJob, runBounded, messageOf,
};
