// @typecheck strict
/**
 * Mocked timers for a test of a module's start() / stop(): does requiring the
 * module arm anything, when do its passes run once it is started, and does
 * stop() call them off.
 *
 *   const timers = useMockedTimers();          // BEFORE the module under test is required
 *   const runner = require('./runner');
 *   test('…', async () => { runner.start(); await timers.advance(10_000); … });
 *
 * Call it before the require: a timer the module arms while it loads is then a
 * mocked one too, and fires in the first test that advances the clock instead
 * of going unnoticed. Only setInterval and setTimeout are mocked, so the pass a
 * timer starts still runs on the real event loop; `advance` waits for it.
 */

'use strict';

const { mock, after } = require('node:test');

function useMockedTimers() {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    after(() => mock.timers.reset());
    return {
        /**
         * Move the clock `ms` forward, then let the passes it started run to their end.
         * @param {number} ms
         */
        async advance(ms) {
            mock.timers.tick(ms);
            await new Promise((resolve) => setImmediate(resolve));
        },
    };
}

module.exports = { useMockedTimers };
