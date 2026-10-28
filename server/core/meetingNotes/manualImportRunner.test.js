/**
 * The slot bookkeeping and the detached run of a manual meeting import.
 *
 * Run: node --test core/meetingNotes/manualImportRunner.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const runner = require('./manualImportRunner');

test.beforeEach(() => {
    runner._resetForTests();
    delete process.env.MEETING_IMPORT_MAX_CONCURRENT_PER_USER;
    delete process.env.MEETING_IMPORT_MAX_CONCURRENT_PER_ORG;
});

test('the same job cannot run twice at once; releasing frees it', () => {
    const a = runner.acquire({ jobKey: 'j1', userId: 'u1' });
    assert.ok(a.ok);
    assert.deepStrictEqual(runner.acquire({ jobKey: 'j1', userId: 'u1' }), { ok: false, reason: 'already_running' });
    a.release();
    a.release(); // idempotent: a double release must not free someone else's slot
    assert.ok(runner.acquire({ jobKey: 'j1', userId: 'u1' }).ok);
});

test('per-user and per-org caps; 0 means unlimited', () => {
    process.env.MEETING_IMPORT_MAX_CONCURRENT_PER_USER = '2';
    process.env.MEETING_IMPORT_MAX_CONCURRENT_PER_ORG = '3';
    assert.ok(runner.acquire({ jobKey: 'a', userId: 'u1', orgId: 'o1' }).ok);
    assert.ok(runner.acquire({ jobKey: 'b', userId: 'u1', orgId: 'o1' }).ok);
    assert.deepStrictEqual(runner.acquire({ jobKey: 'c', userId: 'u1', orgId: 'o1' }), { ok: false, reason: 'user_limit' });
    assert.ok(runner.acquire({ jobKey: 'd', userId: 'u2', orgId: 'o1' }).ok);
    assert.deepStrictEqual(runner.acquire({ jobKey: 'e', userId: 'u3', orgId: 'o1' }), { ok: false, reason: 'org_limit' });

    runner._resetForTests();
    process.env.MEETING_IMPORT_MAX_CONCURRENT_PER_USER = '0';
    process.env.MEETING_IMPORT_MAX_CONCURRENT_PER_ORG = '0';
    for (let i = 0; i < 50; i++) assert.ok(runner.acquire({ jobKey: `k${i}`, userId: 'u1', orgId: 'o1' }).ok);
});

test('runDetached never rejects: a failure goes to onFailure and the slot is released', async () => {
    const slot = runner.acquire({ jobKey: 'j', userId: 'u' });
    assert.ok(slot.ok);
    const seen = [];
    await runner.runDetached({
        label: 'Test', release: slot.release,
        work: async () => { throw new Error('boom'); },
        onFailure: async (err) => { seen.push(err.message); },
    });
    assert.deepStrictEqual(seen, ['boom']);
    assert.ok(runner.acquire({ jobKey: 'j', userId: 'u' }).ok);

    // Even a failing onFailure cannot leak the slot or reject.
    const slot2 = runner.acquire({ jobKey: 'j2', userId: 'u' });
    assert.ok(slot2.ok);
    await runner.runDetached({
        label: 'Test', release: slot2.release,
        work: async () => { throw new Error('boom'); },
        onFailure: async () => { throw new Error('db down'); },
    });
    assert.ok(runner.acquire({ jobKey: 'j2', userId: 'u' }).ok);
});
