// @typecheck strict
/**
 * The first-party module loader: which modules are here, in which state, and what each one
 * contributes to the server's composition.
 *
 * DISCOVERY. A module's composition is the file firstParty/<id>.js of the tree (see
 * modules/firstParty/contract.js for its shape, modules/firstParty/parts.js for its part
 * files). The loader lists that directory with listTreeDir (moduleRoots.cjs), so it finds a
 * composition in server/ or in modules/<id>/server/ alike, and in core mode
 * (BEEFLOW_HIDE_MODULES) a hidden module's composition is simply not listed. Nothing in the
 * core requires a composition by a static path: discovery is the only way in.
 *
 * STATES (modules/firstParty/moduleState.js): a module without a composition, or one the
 * catalog marks unavailable (modules/catalog.js isModuleAvailable; an id the catalog does not
 * know is available), is ABSENT. A composition that throws while it loads, that breaks the
 * contract (loaderRules.js), whose row keys clash with an earlier module's, that sits on a
 * requires cycle, or that requires a module that is absent or failed, is FAILED and
 * contributes nothing; the others carry on. The rest is LOADED. The names a composition
 * provides are declared (declareProvides) before any of its code beyond the composition runs,
 * so an optional lookup of a failed module's name throws instead of answering "absent".
 * Later, a mount row, register() or afterListen() that throws marks its module failed (and
 * every loaded module that requires it); a job, drain or close that throws is only logged,
 * as boot/ does today.
 *
 * ORDER. The rows live in the modules, but their ORDER stays the core's decision: the core's
 * order index (modules/firstParty/order.json, names only) sorts every list the modules
 * contribute. A listed key or name comes at its position; an unlisted one comes after all
 * listed ones, by module id and then by its order inside the module. That keeps today's
 * order where it matters even when it runs against the requires order, e.g. datatableStore
 * stays after automationStore although automation requires datatables.
 *
 * `deps` (an argument of load, for tests): listTreeDir, catalog ({ isModuleAvailable }), log,
 * require (of a composition file) and order (an order index).
 */

'use strict';

const ORDER = require('./order.json');
const moduleState = require('./moduleState');
const {
    SLOTS, STARTUP_PHASE_NAMES, compositionProblem, duplicateKeys, requiresOrder, orderRows, startJob, runBounded, messageOf,
} = require('./loaderRules');

/** @typedef {import('./contract').ModuleComposition} ModuleComposition */
/** @typedef {import('./contract').MountRow} MountRow */
/** @typedef {import('./contract').JobRow} JobRow */
/** @typedef {import('./contract').StoreRow} StoreRow */
/** @typedef {import('./contract').MountSlot} MountSlot */
/** @typedef {import('./contract').Gates} Gates */
/** @typedef {import('./contract').Log} Log */
/** @typedef {import('./contract').AfterListenContext} AfterListenContext */
/** @typedef {{ use: (...args: any[]) => unknown }} Mountable */
/** @typedef {{ mounts: string[], aiMounts: string[], jobs: string[], stores: string[], migrations: string[], nlTranslations: string[] }} OrderIndex */
/**
 * @typedef {{ listTreeDir?: (dir: string) => Array<{ name: string, abs: string }>,
 *   catalog?: { isModuleAvailable: (id: string) => boolean }, log?: Log,
 *   require?: (file: string) => unknown, order?: Partial<OrderIndex> }} LoaderDeps
 */
/** @typedef {'pending' | 'absent' | 'loaded' | 'failed'} EntryState */
/**
 * @typedef {{ id: string, comp: ModuleComposition | null, state: EntryState, detail?: string, started: boolean }} Entry
 *   started: passed load(), so drain and close reach it even after a later failure
 */
/** @typedef {{ id: string, state: 'absent' | 'loaded' | 'failed', requires: string[], uses: string[], detail?: string }} ModuleInfo */

/** A composition file: <id>.js with no further dot (<id>.<part>.js are its parts). */
const COMPOSITION_FILE = /^([A-Za-z][A-Za-z0-9_]*)\.js$/;

/** @type {{ entries: Map<string, Entry>, order: string[], log: Log, index: OrderIndex } | null} */
let current = null;

/**
 * @param {LoaderDeps} deps
 * @returns {{ listTreeDir: NonNullable<LoaderDeps['listTreeDir']>, isAvailable: (id: string) => boolean, log: Log, load: (file: string) => unknown, index: OrderIndex }}
 */
function resolveDeps(deps) {
    const catalog = deps.catalog || require('../catalog');
    return {
        listTreeDir: deps.listTreeDir || ((dir) => require('../../moduleRoots.cjs').listTreeDir(dir)),
        isAvailable: (id) => catalog.isModuleAvailable(id),
        log: deps.log || require('../../telemetry/log'),
        load: deps.require || require,
        index: { ...ORDER, ...deps.order },
    };
}

/**
 * @param {Log} log
 * @param {Entry} entry
 * @param {string} detail
 */
function fail(log, entry, detail) {
    entry.state = 'failed';
    entry.detail = detail;
    moduleState.setModuleState(entry.id, 'failed', detail);
    log.error(`[firstParty] module "${entry.id}" failed: ${detail}`);
}

/**
 * Require and check one composition.
 * @param {ReturnType<typeof resolveDeps>} d
 * @param {string} id
 * @param {string} file
 * @returns {Entry}
 */
function readComposition(d, id, file) {
    /** @type {Entry} */
    const entry = { id, comp: null, state: 'pending', started: false };
    if (!d.isAvailable(id)) return { ...entry, state: 'absent', detail: 'not available in this edition' };
    try {
        const comp = d.load(file);
        const problem = compositionProblem(comp, id);
        if (problem) fail(d.log, entry, problem);
        else entry.comp = /** @type {ModuleComposition} */ (comp);
    } catch (err) {
        fail(d.log, entry, `its composition threw while loading: ${messageOf(err)}`);
    }
    return entry;
}

/**
 * @param {Map<string, Entry>} entries
 * @param {EntryState} [state]
 */
const inState = (entries, state = 'pending') => [...entries.values()].filter((e) => e.state === state);

/**
 * Declare provides, then fail the clashing keys, the cycles and the missing requires.
 * @param {ReturnType<typeof resolveDeps>} d
 * @param {Map<string, Entry>} entries
 * @returns {string[]} the requires order of every module that got this far
 */
function settle(d, entries) {
    for (const e of inState(entries)) {
        try { moduleState.declareProvides(e.id, /** @type {ModuleComposition} */ (e.comp).provides || {}); } catch (err) { fail(d.log, e, messageOf(err)); }
    }
    const pending = inState(entries).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const [id, clash] of duplicateKeys(pending.map((e) => /** @type {ModuleComposition} */ (e.comp)))) {
        fail(d.log, /** @type {Entry} */ (entries.get(id)), `row key "${clash.key}" is already used by module "${clash.owner}"`);
    }
    const { order, cyclic } = requiresOrder(new Map(inState(entries).map((e) => [e.id, e.comp?.requires || []])));
    for (const id of cyclic) fail(d.log, /** @type {Entry} */ (entries.get(id)), `it is on a requires cycle (${cyclic.join(', ')})`);
    for (const id of order) {
        const entry = /** @type {Entry} */ (entries.get(id));
        const missing = (entry.comp?.requires || []).find((r) => entries.get(r)?.state !== 'loaded');
        if (missing === undefined) {
            entry.state = 'loaded';
            entry.started = true;
            moduleState.setModuleState(id, 'loaded');
        } else {
            fail(d.log, entry, `it requires "${missing}", which ${entries.get(missing)?.state === 'failed' ? 'failed' : 'is absent'}`);
        }
    }
    return order;
}

/** @returns {ModuleInfo[]} every module the loader has seen, by id */
function modules() {
    if (!current) return [];
    return [...current.entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => ({
        id: e.id,
        state: /** @type {ModuleInfo['state']} */ (e.state === 'pending' ? 'failed' : e.state),
        requires: [...(e.comp?.requires || [])],
        uses: [...(e.comp?.uses || [])],
        ...(e.detail ? { detail: e.detail } : {}),
    }));
}

/**
 * Discover, check and settle the compositions. Idempotent: a second call returns the first
 * outcome (the test reset starts over).
 * @param {LoaderDeps} [deps]
 * @returns {ModuleInfo[]}
 */
function load(deps = {}) {
    if (current) return modules();
    const d = resolveDeps(deps);
    /** @type {Map<string, Entry>} */
    const entries = new Map();
    for (const { name, abs } of d.listTreeDir('firstParty')) {
        const m = COMPOSITION_FILE.exec(name);
        if (m) entries.set(/** @type {string} */ (m[1]), readComposition(d, /** @type {string} */ (m[1]), abs));
    }
    const order = settle(d, entries);
    current = { entries, order, log: d.log, index: d.index };
    return modules();
}

/** @returns {NonNullable<typeof current>} */
function state() {
    if (!current) load();
    return /** @type {NonNullable<typeof current>} */ (current);
}

/** @returns {Entry[]} the loaded modules, in requires order */
function loadedEntries() {
    const s = state();
    return s.order.map((id) => /** @type {Entry} */ (s.entries.get(id))).filter((e) => e.state === 'loaded');
}

/**
 * Mark a loaded module failed after load(), and every loaded module that requires it.
 * @param {Entry} entry
 * @param {string} detail
 */
function failAtRuntime(entry, detail) {
    const { log } = state();
    fail(log, entry, detail);
    for (const other of loadedEntries()) {
        if ((other.comp?.requires || []).includes(entry.id)) failAtRuntime(other, `it requires "${entry.id}", which failed`);
    }
}

/**
 * The rows the loaded modules contribute to one list, in order-index order.
 * @template R
 * @param {(comp: ModuleComposition) => R[]} pick
 * @param {(row: R) => string} nameOf
 * @param {readonly string[]} listed
 * @returns {Array<{ entry: Entry, row: R }>}
 */
function contributed(pick, nameOf, listed) {
    const items = loadedEntries().flatMap((entry) => pick(/** @type {ModuleComposition} */ (entry.comp)).map((row, index) => ({
        moduleId: entry.id, index, name: nameOf(row), row: { entry, row },
    })));
    return orderRows(items, listed);
}

/**
 * @param {Mountable} target
 * @param {Gates} gates
 * @param {Entry} entry
 * @param {MountRow} row
 */
function mountRow(target, gates, entry, row) {
    try {
        if (row.when && !row.when()) return;
        const handlers = row.handlers(gates);
        if (!Array.isArray(handlers) || handlers.length === 0 || !handlers.every((h) => typeof h === 'function')) {
            throw new TypeError('handlers(gates) did not return a list of middleware');
        }
        if (row.path === null) target.use(...handlers);
        else target.use(row.path, ...handlers);
        if (row.onMount) row.onMount(state().log);
    } catch (err) {
        failAtRuntime(entry, `mount "${row.key}" threw: ${messageOf(err)}`);
    }
}

/**
 * @param {Mountable} target
 * @param {Gates} gates
 * @param {Array<{ entry: Entry, row: MountRow }>} rows
 */
function mountAll(target, gates, rows) {
    for (const { entry, row } of rows) if (entry.state === 'loaded') mountRow(target, gates, entry, row);
}

/**
 * Mount every row of one slot of the main app.
 * @param {Mountable} app
 * @param {Gates} gates
 * @param {MountSlot} slot
 */
function mount(app, gates, slot) {
    if (!SLOTS.includes(slot)) throw new TypeError(`loader.mount: unknown slot "${slot}" (one of ${SLOTS.join(', ')})`);
    mountAll(app, gates, contributed((c) => (c.mounts || []).filter((r) => r.slot === slot), (r) => r.key, state().index.mounts));
}

/**
 * Mount every aiMounts row on the /ai router (routes/ai.js).
 * @param {Mountable} router
 * @param {Gates} gates
 */
function mountAi(router, gates) {
    mountAll(router, gates, contributed((c) => c.aiMounts || [], (r) => r.key, state().index.aiMounts));
}

/**
 * Run a hook of every loaded module that has it, in requires order; a throw fails the module.
 * @param {'register' | 'afterListen'} hook
 * @param {unknown[]} args
 */
function runHook(hook, args) {
    for (const entry of loadedEntries()) {
        const fn = /** @type {((...a: unknown[]) => void) | undefined} */ (entry.comp?.[hook]);
        if (entry.state !== 'loaded' || !fn) continue;
        try { fn(...args); } catch (err) { failAtRuntime(entry, `${hook}() threw: ${messageOf(err)}`); }
    }
}

/** Each loaded module's register(), in requires order. */
function register() {
    runHook('register', []);
}

/**
 * Wiring that needs the listening server, in requires order.
 * @param {import('express').Express} app
 * @param {import('node:http').Server} server
 * @param {AfterListenContext} [ctx]
 */
function afterListen(app, server, ctx = {}) {
    runHook('afterListen', [app, server, ctx]);
}

/**
 * Start every job row of one startup phase, each in its own try/catch.
 * @param {import('./contract').StartupPhase} phase
 * @param {unknown} [ctx]
 */
function runStartupPhase(phase, ctx) {
    if (!STARTUP_PHASE_NAMES.includes(phase)) throw new TypeError(`loader.runStartupPhase: unknown phase "${phase}"`);
    const { log, index } = state();
    for (const { entry, row } of contributed((c) => (c.jobs || []).filter((j) => j.phase === phase), (r) => r.key, index.jobs)) {
        if (entry.state === 'loaded') startJob(log, row, ctx);
    }
}

/**
 * Every module that passed load(), in parallel, each bounded by timeoutMs (loaderRules runBounded).
 * @param {'drain' | 'close'} hook
 * @param {number} timeoutMs
 */
async function settleAll(hook, timeoutMs) {
    const s = state();
    const started = s.order.map((id) => /** @type {Entry} */ (s.entries.get(id))).filter((e) => e.started && e.comp?.[hook]);
    await Promise.all(started.map((e) => runBounded(s.log, `module ${e.id} ${hook}`,
        /** @type {(opts: { timeoutMs: number }) => Promise<void>} */ (e.comp?.[hook]), timeoutMs)));
}

/**
 * Shutdown, first half: every module that loaded, in parallel, each bounded by timeoutMs.
 * @param {{ timeoutMs: number }} opts
 */
function drain({ timeoutMs }) {
    return settleAll('drain', timeoutMs);
}

/**
 * Shutdown, second half: the same for close().
 * @param {{ timeoutMs?: number }} [opts]
 */
function close({ timeoutMs = 10_000 } = {}) {
    return settleAll('close', timeoutMs);
}

/** @returns {StoreRow[]} the store rows of the loaded modules, in order-index order */
function stores() {
    return contributed((c) => c.stores || [], (r) => r.name, state().index.stores).map(({ row }) => ({ name: row.name, file: row.file }));
}

/** @returns {string[]} the loose migrations of the loaded modules, in order-index order */
function migrations() {
    return contributed((c) => c.migrations || [], (n) => n, state().index.migrations).map(({ row }) => row);
}

/** @returns {string[]} the Dutch seed migrations of the loaded modules, in order-index order */
function nlTranslations() {
    return contributed((c) => c.nlTranslations || [], (n) => n, state().index.nlTranslations).map(({ row }) => row);
}

/** Test seam: forget the outcome of load() and every module state. */
function _resetLoaderForTests() {
    current = null;
    moduleState._resetModuleStateForTests();
}

module.exports = {
    load, modules, mount, mountAi, register, runStartupPhase, afterListen, drain, close,
    stores, migrations, nlTranslations, _resetLoaderForTests, SLOTS, STARTUP_PHASE_NAMES,
};
