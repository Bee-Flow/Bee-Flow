/**
 * Boot starts the company-inbox retention job (jobs/supportThreadRetention.mts)
 * with the other Support jobs: boot/startupJobs.js startSupportRetention, which
 * startSupportAndSyncJobs calls. The job and the module switch are injected, so
 * nothing really starts: no timer, no database.
 *
 * Run: cd server && node --test boot/startupJobs.supportRetention.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startSupportRetention } = require('./startupJobs');

test('the retention job starts when the Support module is available', () => {
    let started = 0;
    /** @type {string[]} */
    const asked = [];
    startSupportRetention({
        isAvailable: (id) => { asked.push(id); return true; },
        job: { start: () => { started++; } },
    });
    assert.deepEqual(asked, ['support']);
    assert.equal(started, 1);
});

test('the retention job does not start when the Support module is switched off', () => {
    let started = 0;
    startSupportRetention({ isAvailable: () => false, job: { start: () => { started++; } } });
    assert.equal(started, 0);
});

test('a retention job that fails to start does not stop boot', () => {
    assert.doesNotThrow(() => startSupportRetention({
        isAvailable: () => true,
        job: { start: () => { throw new Error('no database'); } },
    }));
});
