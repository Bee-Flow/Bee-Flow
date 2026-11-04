/**
 * gmeetManualImport.startBackgroundImport — a manual import never starts a
 * second ingest of a job another run is in the middle of, and marks the job
 * as the user's own request.
 *
 * Run: cd server && node --test core/meetingNotes/gmeetManualImport.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const fx = { job: null, updates: [], heartbeats: 0 };
const manualImport = require('./gmeetManualImport');
manualImport.init({
    store: {
        getJob: async () => fx.job,
        updateJob: async (id, fields) => { fx.updates.push(fields); return true; },
        heartbeatJob: async () => { fx.heartbeats++; return true; },
        failJob: async () => true,
    },
});
const { startBackgroundImport } = manualImport;

const at = (min) => new Date(Date.now() + min * 60_000).toISOString();
function args(over = {}) {
    let accepted = 0;
    return {
        a: {
            job: { id: 'job-1' }, userId: 'u1', orgId: 'orgA', knownCodes: {},
            work: async () => {}, accept: () => { accepted++; }, tooMany: () => new Error('too many'),
            ...over,
        },
        accepted: () => accepted,
    };
}

test.beforeEach(() => { fx.job = null; fx.updates = []; fx.heartbeats = 0; });

test('a job the poller is ingesting right now is not started a second time', async () => {
    // A freshly renewed 120-minute ingest lease on a still-pending row.
    fx.job = { id: 'job-1', status: 'pending', updatedAt: at(-3), nextAttemptAt: at(117) };
    const { a, accepted } = args();
    assert.strictEqual(await startBackgroundImport(a), 'already_running');
    assert.strictEqual(accepted(), 0, 'the route answers for an already running import');
    assert.deepStrictEqual(fx.updates, [], 'the running job is not reset');
});

test('a job in retry backoff can be started by hand, and is marked as the user\'s request', async () => {
    fx.job = { id: 'job-1', status: 'pending', updatedAt: at(-1), nextAttemptAt: at(4) };
    const { a, accepted } = args({ job: { id: 'job-2' }, language: 'en', contextTerms: 'Foo' });
    assert.strictEqual(await startBackgroundImport(a), 'started');
    assert.strictEqual(accepted(), 1);
    assert.strictEqual(fx.updates[0].requestedByUser, true);
    assert.strictEqual(fx.updates[0].requestedLanguage, 'en');
    assert.strictEqual(fx.updates[0].contextTerms, 'Foo');
    assert.strictEqual(fx.updates[0].status, 'pending');
});
