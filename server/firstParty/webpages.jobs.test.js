'use strict';
/**
 * firstParty/webpages.jobs.js: the after-listen wiring of the webpage full-tier runtime
 * (moved out of boot/lifecycle.js). The reaper always starts; only with the runtime on is
 * the proxy mounted, after which the terminal error handler is registered again behind it.
 *
 * Run: cd server && node --test firstParty/webpages.jobs.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const part = require('./webpages.jobs');

/** @param {boolean} enabled */
function wire(enabled) {
    /** @type {string[]} */
    const order = [];
    const app = /** @type {any} */ ({ use: (/** @type {Function} */ fn) => order.push(`app.use:${fn.name}`) });
    const server = /** @type {any} */ ({});
    /** @type {unknown[][]} */
    const info = [];
    const log = { info: (/** @type {unknown[]} */ ...a) => info.push(a), warn() {}, error() {} };
    part.afterListen(app, server, { terminalErrorHandler: function terminalErrorHandler() {}, log }, {
        webpageRuntimeManager: { startReaper: () => { order.push('startReaper'); }, isEnabled: () => enabled },
        fullTierProxy: { mountFullTierProxy: (a, s) => { order.push(`mountFullTierProxy:${a === app}:${s === server}`); } },
    });
    return { order, info };
}

test('runtime off: the reaper starts, nothing is mounted', () => {
    assert.deepEqual(wire(false), { order: ['startReaper'], info: [] });
});

test('runtime on: the proxy mounts on the app and the server, then the terminal handler is registered behind it', () => {
    const { order, info } = wire(true);
    assert.deepEqual(order, ['startReaper', 'mountFullTierProxy:true:true', 'app.use:terminalErrorHandler']);
    assert.deepEqual(info, [['[Server] Webpage full-tier runtime proxy mounted (WEBPAGE_FULL_RUNTIME_ENABLED=1).']]);
});
