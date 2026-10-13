/**
 * core/meetingNotes/importJobKit — the plumbing the Meet, Teams and Talk
 * engines shared by copy. Pins the behaviour each engine had inline.
 *
 * Run: cd server && node --test core/meetingNotes/importJobKit.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const kit = require('./importJobKit');

test('backoff follows the table by attempt count, then settles hourly', () => {
    assert.deepStrictEqual([0, 1, 2, 3, 4].map(kit.backoffMsFor), [2, 5, 10, 20, 40].map((m) => m * 60_000));
    assert.strictEqual(kit.backoffMsFor(5), 60 * 60_000);
    assert.strictEqual(kit.backoffMsFor(undefined), 2 * 60_000);
    assert.strictEqual(kit.backoffMsFor(-3), 2 * 60_000);
});

test('meetingEndMs prefers the end, then the creation time', () => {
    assert.strictEqual(kit.meetingEndMs({ meetingEnd: '2026-01-01T10:00:00Z', createdAt: '2025-01-01T00:00:00Z' }), Date.parse('2026-01-01T10:00:00Z'));
    assert.strictEqual(kit.meetingEndMs({ createdAt: '2025-01-01T00:00:00Z' }), Date.parse('2025-01-01T00:00:00Z'));
    const now = Date.now();
    assert.ok(kit.meetingEndMs({}) >= now);
});

test('ingestAttempt reads the attempt marker only off a failed job', () => {
    assert.strictEqual(kit.ingestAttempt({ errorCode: 'no_recording', lastError: 'attempt 2/3: x' }), 0);
    assert.strictEqual(kit.ingestAttempt({ errorCode: 'failed', lastError: 'attempt 2/3: x' }), 2);
    assert.strictEqual(kit.ingestAttempt({ errorCode: 'failed', lastError: 'boom' }), 1);
});

test('resolveOrgIdForUser answers null when the store fails', async () => {
    assert.strictEqual(await kit.resolveOrgIdForUser('u', () => ({ getUser: async () => ({ organizationId: 'o' }) })), 'o');
    assert.strictEqual(await kit.resolveOrgIdForUser('u', () => { throw new Error('no store'); }), null);
});

test('candidates: own settings docs plus members of orgs that turned the flag on', async () => {
    const configStore = { getAllConfig: async () => ({
        user_talk_notes_u1: {}, org_talk_notes_o1: {}, org_talk_notes_o2: {}, user_gmeet_notes_x: {},
    }) };
    const users = await kit.listCandidateUsers({
        configStore,
        kind: 'talk_notes',
        resolveSettings: async ({ orgId }) => (orgId === 'o1' ? { autoRecord: true } : { autoRecord: false }),
        flag: 'autoRecord',
        getUserStore: () => ({ getAllUsers: async () => [
            { id: 'u2', organizationId: 'o1' }, { id: 'u3', organizationId: 'o2' }, { id: 'u1', organizationId: 'o1' },
        ] }),
    });
    assert.deepStrictEqual(users, ['u1', 'u2']);
});

test('candidates: a failing config read or user list is best-effort', async () => {
    const users = await kit.listCandidateUsers({
        configStore: { getAllConfig: async () => { throw new Error('db'); } },
        kind: 'gmeet_notes', resolveSettings: async () => ({}), flag: 'autoImport', getUserStore: () => ({}),
    });
    assert.deepStrictEqual(users, []);
    const users2 = await kit.listCandidateUsers({
        configStore: { getAllConfig: async () => ({ org_gmeet_notes_o: {}, user_gmeet_notes_a: {} }) },
        kind: 'gmeet_notes', resolveSettings: async () => ({ autoImport: true }), flag: 'autoImport',
        getUserStore: () => ({ getAllUsers: async () => { throw new Error('db'); } }),
    });
    assert.deepStrictEqual(users2, ['a']);
});

test('discovery walks at most N users per tick and resumes where it stopped; one failure does not stop the rest', async () => {
    const seen = [];
    const discover = kit.makeDiscovery({
        label: 'T', maxUsersPerTick: 2, jitterMs: 1,
        listCandidateUsers: async () => ['a', 'b', 'c'],
        discoverUser: async (u) => { seen.push(u); if (u === 'a') throw new Error('x'); },
    });
    await discover();
    await discover();
    assert.deepStrictEqual(seen, ['a', 'b', 'c', 'a']);
});

test('discovery survives a failing candidate scan', async () => {
    const discover = kit.makeDiscovery({
        label: 'T', maxUsersPerTick: 2, jitterMs: 1,
        listCandidateUsers: async () => { throw new Error('scan'); },
        discoverUser: async () => { throw new Error('never'); },
    });
    await discover();
});

function fakeStore() {
    const calls = [];
    return { calls, failJob: async (id, opts) => { calls.push([id, opts]); } };
}

test('failIngest: a terminal code freezes the job under that code and rethrows the original', async () => {
    const store = fakeStore(); const terminal = [];
    const err = Object.assign(new Error('nope'), { code: 'no_recording' });
    await assert.rejects(() => kit.failIngest({
        store, job: { id: 'j' }, err, terminalCodes: new Set(['no_recording']), maxAttempts: 3,
        fallbackMessage: 'F', onTerminal: async (j) => { terminal.push(j.id); },
    }), (e) => e === err);
    assert.deepStrictEqual(store.calls, [['j', { errorCode: 'no_recording', terminal: true, lastError: 'nope' }]]);
    assert.deepStrictEqual(terminal, ['j']);
});

test('failIngest: an unclassified error retries with backoff, then freezes as failed', async () => {
    const store = fakeStore(); const terminal = [];
    const args = { store, terminalCodes: new Set(), maxAttempts: 3, fallbackMessage: 'F', onTerminal: async (j) => { terminal.push(j.id); } };
    await assert.rejects(() => kit.failIngest({ ...args, job: { id: 'j', attempts: 1 }, err: new Error('boom') }),
        (e) => e.code === 'failed' && e.message === 'boom');
    assert.deepStrictEqual(store.calls[0], ['j', { errorCode: 'failed', lastError: 'attempt 1/3: boom', terminal: false, status: 'pending', backoffMs: 5 * 60_000 }]);
    assert.deepStrictEqual(terminal, []);
    await assert.rejects(() => kit.failIngest({ ...args, job: { id: 'j', errorCode: 'failed', lastError: 'attempt 2/3: boom' }, err: {} }),
        (e) => e.code === 'failed' && e.message === 'F');
    assert.deepStrictEqual(store.calls[1], ['j', { errorCode: 'failed', terminal: true, lastError: 'attempt 3/3: [object Object]' }]);
    assert.deepStrictEqual(terminal, ['j']);
});

test('processDueJobs runs every claimed job, survives a failing one and a failing claim', async () => {
    const ran = [];
    await kit.processDueJobs({
        store: { claimDueJobs: async (limit) => [{ id: 1 }, { id: 2 }].slice(0, limit) },
        limit: 2, label: 'T', describe: (j) => String(j.id), quietCodes: new Set(['quiet']),
        processClaimedJob: async (j) => { ran.push(j.id); if (j.id === 1) throw Object.assign(new Error('q'), { code: 'quiet' }); },
    });
    assert.deepStrictEqual(ran, [1, 2]);
    await kit.processDueJobs({
        store: { claimDueJobs: async () => { throw new Error('db'); } },
        limit: 2, label: 'T', describe: String, quietCodes: new Set(), processClaimedJob: async () => { throw new Error('never'); },
    });
});
