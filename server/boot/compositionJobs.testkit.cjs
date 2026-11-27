'use strict';
/**
 * The job recorder of boot/composition.jobs.characterisation.test.js: a child
 * process that runs every phase of STARTUP_PHASES (boot/startupTasks.js), and
 * runStartupChecks before them, with every module they require replaced by a
 * recorder, then the SIGTERM shutdown of boot/lifecycle.js the same way, and
 * writes what was called to a JSON file.
 *
 *   cd server && node boot/compositionJobs.testkit.cjs <out.json>
 *
 * HOW. Module._load is intercepted: a request from the code under test returns,
 * instead of the module, a recorder for its tree path. Calling any function on
 * it (`require('../jobs/x').start()`, `mcpManager.initialize()`) records
 * { module, method } under the running phase and returns a value that settles
 * with undefined when awaited;
 * nothing real is loaded, so no timer, database or network is started by a job.
 * Only the phase files themselves (boot/startup*.js, boot/lifecycle.js) and the
 * plumbing they read synchronously (REAL below: the logger, bestEffort, the env
 * readers, the boot-step tracker, the module catalog) are the real modules.
 *
 * Timers: while a phase runs, setTimeout / setInterval / setImmediate only
 * collect their callback; after the phase each collected callback runs once
 * (an interval too), still attributed to that phase, until none is left. So
 * work a phase defers (the 8 s connector probe, the 5 s orphan purge) is
 * recorded where it is scheduled. `requires` lists every module a phase asked
 * for, called or not (a require for its side effect, such as compliance/checks).
 *
 * Shutdown: the calls made inside the first-party loader's drain and close
 * (each module's drain, or close, runs concurrently with the others') are one
 * entry per hook, { concurrently: 'drain' | 'close', calls }, sorted; every
 * other shutdown call is an entry of its own, in order.
 *
 * The environment is the default one (BEEFLOW_EDITION, DEPLOYMENT_MODE and the
 * per-job switches unset): every module available, the cloud billing jobs on.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const outFile = process.argv[2];
if (!outFile) {
    process.stderr.write('usage: compositionJobs.testkit.cjs <out.json> (cwd: server/)\n');
    process.exit(2);
}
process.on('unhandledRejection', () => { /* a recorder result read as data; nothing real failed */ });

const { toTreePath } = require('../moduleRoots.cjs');

/** Tree paths that load for real: the code under test and the plumbing it reads synchronously. */
const REAL = new Set([
    'boot/startupTasks.js', 'boot/startupJobs.js', 'boot/startupProbes.js', 'boot/startupOneShots.js',
    'boot/startupBilling.js', 'boot/startupPrunes.js', 'boot/startupSystemAgents.js', 'boot/lifecycle.js',
    'telemetry/log.js', 'utils/bestEffort.js', 'utils/envNumber.mts', 'utils/runtimeState.mts', 'modules/catalog.js',
    // The first-party loader the phases and the shutdown hand the module rows to (loaded before
    // the recording starts, see main); the rows' own requires are recorded like the core's.
    'modules/firstParty/loader.js', 'modules/firstParty/loaderRules.js', 'modules/firstParty/moduleState.js',
    'modules/firstParty/parts.js', 'moduleRoots.cjs', 'boot/optionalRequire.js',
]);

/** @type {string | null} */
let phase = null;
/** @type {string | null} the shutdown hook of the loader that is running (its calls are concurrent) */
let group = null;
/** @type {Array<{ phase: string, module: string, method: string }>} */
const calls = [];
/** @type {Map<string, Set<string>>} */
const requires = new Map();

/**
 * What a recorded call returns: anything may be read from it or called on it, and
 * awaiting it (or .then / .catch / .finally) settles with undefined. Not recorded.
 * @returns {any}
 */
function result() {
    const settled = () => Promise.resolve(undefined);
    return new Proxy(function value() { /* never runs */ }, {
        get(_t, prop) {
            if (prop === 'then') return (/** @type {any} */ ok, /** @type {any} */ fail) => settled().then(ok, fail);
            if (prop === 'catch') return () => settled();
            if (prop === 'finally') return (/** @type {any} */ cb) => settled().finally(cb);
            if (typeof prop === 'symbol') return undefined;
            return result();
        },
        apply: () => result(),
        construct: () => result(),
    });
}

/** @param {string} mod @param {string[]} chain */
function recorder(mod, chain) {
    const target = function recorded() { /* never runs: the proxy answers */ };
    return new Proxy(target, {
        get(_t, prop) {
            if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') return undefined;
            return recorder(mod, [...chain, prop]);
        },
        apply() {
            calls.push({ phase: phase || '(none)', module: mod, method: chain.join('.'), group });
            return result();
        },
        construct() {
            calls.push({ phase: phase || '(none)', module: mod, method: `new ${chain.join('.')}` });
            return recorder(mod, [...chain, '(instance)']);
        },
    });
}

const realLoad = Module._load;
let intercepting = false;
Module._load = function recordingLoad(request, parent, isMain) {
    if (!intercepting) return realLoad.apply(this, [request, parent, isMain]);
    let file = null;
    try { file = Module._resolveFilename(request, parent, isMain); } catch (_) { /* unresolvable: let the real loader say so */ }
    const rel = file && path.isAbsolute(file) && !file.includes(`${path.sep}node_modules${path.sep}`) ? toTreePath(file) : null;
    if (!rel || REAL.has(rel)) return realLoad.apply(this, [request, parent, isMain]);
    if (phase) {
        if (!requires.has(phase)) requires.set(phase, new Set());
        requires.get(phase).add(rel);
    }
    return recorder(rel, []);
};

// ── Timers: collect while a phase runs, run once afterwards ──────────
const realTimers = { setTimeout, setInterval, setImmediate };
/** @type {Array<() => unknown>} */
let pending = [];
const fakeTimer = { unref() { return this; }, ref() { return this; }, hasRef: () => false };
/** @param {Function} fn @param {any[]} args */
const collect = (fn, args) => { pending.push(() => fn(...args)); return fakeTimer; };

function fakeTimers(on) {
    if (on) {
        global.setTimeout = /** @type {any} */ ((fn, _ms, ...args) => collect(fn, args));
        global.setInterval = /** @type {any} */ ((fn, _ms, ...args) => collect(fn, args));
        global.setImmediate = /** @type {any} */ ((fn, ...args) => collect(fn, args));
    } else Object.assign(global, realTimers);
}

const settle = () => new Promise((resolve) => realTimers.setImmediate(resolve));

/** Run `fn` as phase `name`, then every callback it deferred, until none is left. @param {string} name @param {() => unknown} fn */
async function runPhase(name, fn) {
    phase = name;
    fakeTimers(true);
    try {
        try { await fn(); } catch (_) { /* a phase that trips over a recorder value: its calls so far are recorded */ }
        for (let round = 0; round < 20; round += 1) {
            await settle();
            const due = pending;
            pending = [];
            if (!due.length) break;
            for (const run of due) { try { await run(); } catch (_) { /* as above */ } }
        }
        await settle();
    } finally {
        fakeTimers(false);
        phase = null;
    }
}

/** Each { module, method } once, in the order first seen (an interval's tick and its first timeout call the same). */
const unique = (/** @type {Array<{ module: string, method: string }>} */ list) => {
    const seen = new Set();
    return list.map(({ module, method }) => ({ module, method })).filter((c) => {
        const k = `${c.module} ${c.method}`;
        return seen.has(k) ? false : (seen.add(k), true);
    });
};

/**
 * The shutdown calls in order, except that the calls made inside one loader hook (the modules'
 * drains run concurrently, so do their closes) are one entry { concurrently: hook, calls },
 * sorted: their order among themselves is not part of the sequence.
 * @param {Array<{ module: string, method: string, group?: string | null }>} list
 */
function groupConcurrent(list) {
    /** @type {any[]} */
    const out = [];
    for (const { module, method, group: g } of list) {
        const last = out.at(-1);
        if (!g) out.push({ module, method });
        else if (last && last.concurrently === g) last.calls.push({ module, method });
        else out.push({ concurrently: g, calls: [{ module, method }] });
    }
    for (const entry of out) {
        if (entry.calls) entry.calls.sort((/** @type {any} */ a, /** @type {any} */ b) => `${a.module} ${a.method}`.localeCompare(`${b.module} ${b.method}`));
    }
    return out;
}

async function main() {
    const { STARTUP_PHASES, runStartupChecks } = require('./startupTasks');
    const lifecycle = require('./lifecycle');
    // The compositions load for real, before the recording: what a module contributes is
    // recorded where its rows run, not where the loader discovers them.
    const loader = require('../modules/firstParty/loader');
    loader.load();
    /** The loader's drain and close, with their calls marked as one concurrent group each. @param {'drain' | 'close'} hook */
    const grouped = (hook) => async (/** @type {any} */ opts) => {
        group = hook;
        try { await loader[hook](opts); } finally { group = null; }
    };
    const shutdownLoader = { drain: grouped('drain'), close: grouped('close') };
    const realExit = process.exit;
    process.exit = /** @type {any} */ ((code) => { calls.push({ phase: phase || '(none)', module: 'process', method: `exit(${code})` }); });
    intercepting = true;
    await runPhase('runStartupChecks', () => runStartupChecks());
    for (const fn of STARTUP_PHASES) await runPhase(fn.name, () => fn());
    /** @param {string} module @param {string} method */
    const note = (module, method) => { calls.push({ phase: 'shutdown', module, method }); };
    const server = {
        close: () => note('http.Server', 'close'),
        closeIdleConnections: () => note('http.Server', 'closeIdleConnections'),
        closeAllConnections: () => note('http.Server', 'closeAllConnections'),
    };
    await runPhase('shutdown', async () => {
        /** @type {Record<string, Function>} */
        const handlers = {};
        const proc = { on: (/** @type {string} */ sig, /** @type {Function} */ h) => { handlers[sig] = h; }, exit: (/** @type {number} */ code) => note('process', `exit(${code})`) };
        const otel = { shutdown: async () => note('otel', 'shutdown') };
        const disconnectRedis = async () => note('db', 'disconnectRedis');
        lifecycle.installGracefulShutdown({ otel, disconnectRedis, server, proc: /** @type {any} */ (proc), log: { info() {}, warn() {} }, deps: { loader: shutdownLoader } });
        await handlers.SIGTERM();
    });
    intercepting = false;
    process.exit = realExit;
    const startup = calls.filter((c) => c.phase !== 'shutdown');
    const out = {
        phases: ['runStartupChecks', ...STARTUP_PHASES.map((f) => f.name)].map((name) => ({
            phase: name,
            calls: unique(startup.filter((c) => c.phase === name)),
            requires: [...(requires.get(name) || [])].sort(),
        })),
        shutdown: groupConcurrent(calls.filter((c) => c.phase === 'shutdown')),
    };
    fs.writeFileSync(outFile, JSON.stringify(out));
    realExit(0);
}

main().catch((err) => {
    process.stderr.write(`compositionJobs: ${err && err.stack}\n`);
    process.exit(3);
});
