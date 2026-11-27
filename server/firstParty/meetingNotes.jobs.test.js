'use strict';
/**
 * firstParty/meetingNotes.jobs.js: the shutdown drain of the module (moved out of
 * boot/lifecycle.js). The meeting-notes runs of this process are marked failed, bounded
 * well under the termination grace, and a failure there is logged, never thrown, so the
 * shutdown goes on.
 *
 * Run: cd server && node --test firstParty/meetingNotes.jobs.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const part = require('./meetingNotes.jobs');

function recordingLog() {
    /** @type {{ info: unknown[][], warn: unknown[][] }} */
    const lines = { info: [], warn: [] };
    return { lines, info: (/** @type {unknown[]} */ ...a) => lines.info.push(a), warn: (/** @type {unknown[]} */ ...a) => lines.warn.push(a), error() {} };
}

test('the drain fails the runs in flight once, with its own bound, and says how many', async () => {
    /** @type {number[]} */
    const asked = [];
    const log = recordingLog();
    await part.drain({ timeoutMs: 25_000 }, { log, meetingRuns: { failInFlight: async ({ timeoutMs }) => { asked.push(timeoutMs); return 2; } } });
    assert.deepEqual(asked, [5000], 'failInFlight is called once, bounded well under the termination grace');
    assert.deepEqual(log.lines.info, [['[Server] 2 meeting note run(s) interrupted by the shutdown, marked failed for a retry']]);
});

test('a failure there is logged and does not reject', async () => {
    const log = recordingLog();
    await part.drain({ timeoutMs: 25_000 }, { log, meetingRuns: { failInFlight: async () => { throw new Error('db gone'); } } });
    assert.deepEqual(log.lines.warn, [['[Server] marking interrupted meeting runs failed:', 'db gone']]);
});

test('the saved-audio backfill is a row of the support-and-sync phase', () => {
    assert.deepEqual(part.jobs.map((j) => [j.key, j.phase, j.label]), [
        ['meetingNotes:savedAudioBackfill', 'startSupportAndSyncJobs', 'Saved-audio backfill'],
    ]);
});
