'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const job = require('./encryptionBackfillJob');

const tick = () => new Promise((r) => setImmediate(r));
test.beforeEach(() => job._reset());

test('unknown org is idle', () => {
    const s = job.get('x');
    assert.strictEqual(s.status, 'idle');
    assert.deepStrictEqual(s.surfaces, {});
});

test('runs, records progress, finishes done', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const backfillOrg = async (orgId, opts) => {
        assert.strictEqual(orgId, 'o1');
        assert.strictEqual(opts.dryRun, true);
        opts.onProgress('messages', { encrypted: 1, skipped: 0, noKey: 0, failed: 0 });
        await gate;
        return { orgId, tier: 'managed', surfaces: { messages: { encrypted: 3, skipped: 1, noKey: 0, failed: 0 } } };
    };
    const r = job.start('o1', true, { backfillOrg });
    assert.strictEqual(r.started, true);
    assert.strictEqual(r.job.status, 'running');
    await tick();
    assert.strictEqual(job.get('o1').surfaces.messages.encrypted, 1);
    release();
    await tick(); await tick();
    const s = job.get('o1');
    assert.strictEqual(s.status, 'done');
    assert.strictEqual(s.dryRun, true);
    assert.strictEqual(s.surfaces.messages.encrypted, 3);
    assert.ok(s.finishedAt);
});

test('a second start while running is refused', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const backfillOrg = async () => { await gate; return { surfaces: {} }; };
    assert.strictEqual(job.start('o1', false, { backfillOrg }).started, true);
    const again = job.start('o1', false, { backfillOrg });
    assert.strictEqual(again.started, false);
    assert.strictEqual(again.job.status, 'running');
    release();
    await tick(); await tick();
});

test('a throw becomes a generic error, never the message', async () => {
    const backfillOrg = async () => { throw new Error('secret db detail'); };
    job.start('o1', false, { backfillOrg });
    await tick(); await tick();
    const s = job.get('o1');
    assert.strictEqual(s.status, 'error');
    assert.strictEqual(s.error, job.GENERIC_ERROR);
    assert.ok(!JSON.stringify(s).includes('secret'));
});

test('finished state is kept until the next start, which replaces it', async () => {
    job.start('o1', true, { backfillOrg: async () => ({ surfaces: { a: { encrypted: 1 } } }) });
    await tick(); await tick();
    assert.strictEqual(job.get('o1').status, 'done');
    job.start('o1', false, { backfillOrg: async () => new Promise(() => {}) });
    const s = job.get('o1');
    assert.strictEqual(s.status, 'running');
    assert.strictEqual(s.dryRun, false);
    assert.deepStrictEqual(s.surfaces, {});
});

test('orgs are independent', async () => {
    job.start('a', true, { backfillOrg: async () => new Promise(() => {}) });
    assert.strictEqual(job.start('b', true, { backfillOrg: async () => ({ surfaces: {} }) }).started, true);
});
