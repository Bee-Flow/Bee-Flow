'use strict';

/**
 * Connector loader — it requires every file in this directory at boot, so it
 * must skip the colocated *.test.js files: requiring one would run its tests,
 * and the stubs they install, inside the live process. A test file the loader
 * did require shows up as a "missing id/collect" warning.
 *
 * Run: cd server && node --test compliance/connectors/index.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const log = require('../../telemetry/log');
const logged = [];
const { warn, error } = log;
log.warn = (...args) => { logged.push(args.join(' ')); };
log.error = (...args) => { logged.push(args.join(' ')); };
let connectors;
try {
    connectors = require('./index');
} finally {
    log.warn = warn;
    log.error = error;
}

test('the loader never requires a test file', () => {
    assert.deepEqual(logged.filter(line => /\.test\.js/.test(line)), []);
});

test('every connector source still loads', () => {
    const sources = fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && f !== 'index.js' && !/\.test\.js$/.test(f));
    assert.equal(connectors.getAll().length, sources.length);
});
