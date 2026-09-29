/**
 * Mount a background worker's start() against captured timers and a stand-in
 * runtime module gate, for the "removing the module stops the worker" tests
 * (BFSF-438).
 *
 * The stand-in has the contract of modules.moduleGatedTick (pinned in
 * modules/moduleGatedTick.test.js): it is consulted on every invocation, it
 * no-ops while the module is inactive, and it passes through otherwise.
 * `state.active` is read per invocation, so a test can flip it after start().
 * The gate is handed in through start({ gate }), so no module-system mocking
 * is needed for it.
 *
 *   const w = mountGated((opts) => worker.start(opts));
 *   w.state.active = false;
 *   await w.fireAll();          // every captured interval and boot timeout
 *   assert.deepStrictEqual(w.state.consulted.map(c => c.moduleId), ['support']);
 */

'use strict';

/**
 * @param {(opts: object) => void} startFn calls the worker's start with the given options
 * @param {object} [opts] extra start() options (e.g. intervalMs)
 */
function mountGated(startFn, opts = {}) {
    const state = { active: true, consulted: [], passed: 0 };
    const gate = (moduleId, fn, name) => {
        state.consulted.push({ moduleId, fn, name });
        return async function gatedStandIn(...args) {
            if (!state.active) return undefined;
            state.passed += 1;
            return fn(...args);
        };
    };

    const timers = [];
    const realSetInterval = globalThis.setInterval;
    const realSetTimeout = globalThis.setTimeout;
    const capture = (kind) => (callback, delay) => {
        const h = { kind, callback, delay, unref() { return this; }, ref() { return this; } };
        timers.push(h);
        return h;
    };
    globalThis.setInterval = capture('interval');
    globalThis.setTimeout = capture('timeout');
    try {
        startFn({ ...opts, gate });
    } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.setTimeout = realSetTimeout;
    }

    return {
        state,
        timers,
        /**
         * Fire every captured timer once, letting each tick settle before the
         * next fires (real timers are far apart; a worker's in-flight guard
         * would otherwise swallow the second tick).
         */
        async fireAll() {
            for (const t of timers) {
                await t.callback();
                await new Promise((resolve) => setImmediate(resolve));
                await new Promise((resolve) => setImmediate(resolve));
            }
        },
    };
}

module.exports = { mountGated };
