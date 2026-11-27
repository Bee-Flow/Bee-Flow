'use strict';
/**
 * firstParty/cowork.jobs.js: the cowork module's startup jobs (moved out of boot/startupJobs.js).
 * The cowork tick and the coverage prune are armed in the module-scheduler phase, the rest in the
 * support-and-sync phase, each a row of its own with the label of its old log line (the loader
 * reports a row that throws by that label and goes on with the next: loaderRules.test.js).
 *
 * Run: cd server && node --test firstParty/cowork.jobs.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { jobs } = require('./cowork.jobs');

test('the cowork runner and the coverage prune are rows of the module-scheduler phase, in that order', () => {
    assert.deepEqual(jobs.filter((j) => j.phase === 'startModuleSchedulers').map((j) => [j.key, j.label, j.failText]), [
        ['cowork:runner', 'Cowork runner', 'start failed'],
        ['cowork:coveragePrune', 'Cowork coverage prune', 'start failed'],
    ]);
});

test('the other cowork jobs are rows of the support-and-sync phase', () => {
    assert.deepEqual(jobs.filter((j) => j.phase === 'startSupportAndSyncJobs').map((j) => j.key), [
        'cowork:afterCowork', 'cowork:receipts', 'cowork:habitSweep', 'cowork:goalMeasure',
        'cowork:repairs', 'cowork:autoResolve', 'cowork:stableSteps', 'cowork:dailyMail',
    ]);
});
