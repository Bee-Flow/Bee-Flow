/**
 * ISMS document store tests — version freeze semantics, edited-flag nudge,
 * seed-never-overwrites, idempotent acknowledgements.
 *
 * Run: cd server && node --test stores/ismsDocStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const calls = { run: [], getOne: [], getAll: [] };
let oneQueue = [];

const mockDb = {
    exec: async () => {},
    run: async (sql, params) => { calls.run.push({ sql, params }); return { rowCount: 1, rows: [] }; },
    getOne: async (sql, params) => { calls.getOne.push({ sql, params }); return oneQueue.length ? oneQueue.shift() : null; },
    getAll: async (sql, params) => { calls.getAll.push({ sql, params }); return []; },
};
const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const store = require('./ismsDocStore');

beforeEach(() => {
    calls.run.length = 0;
    calls.getOne.length = 0;
    calls.getAll.length = 0;
    oneQueue = [];
});

test('publish freezes the draft as version+1 with a sha256 over the body', async () => {
    const body = '# Access Control Policy\nrules here';
    oneQueue = [
        { organization_id: 'o', slug: 'access-control', title: 'Access Control', draft_body: body, current_version: 2, edited: true }, // publish() lookup
        { organization_id: 'o', slug: 'access-control', title: 'Access Control', current_version: 3, status: 'published' },            // getDoc doc row
        { version: 3, body, sha256: 'x' },                                                                                             // getDoc version row
    ];
    const doc = await store.publish('o', 'access-control', 'actor');
    const insert = calls.run.find(c => c.sql.includes('INSERT INTO isms_document_versions'));
    assert.ok(insert, 'version row inserted');
    assert.strictEqual(insert.params[2], 3, 'version increments');
    const expectedHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    assert.strictEqual(insert.params[5], expectedHash, 'sha256 computed over the exact body');
    assert.strictEqual(doc.published_hash, expectedHash);
    const bump = calls.run.find(c => c.sql.includes("status = 'published'"));
    assert.strictEqual(bump.params[2], 3);
});

test('publish refuses an empty draft', async () => {
    oneQueue = [{ organization_id: 'o', slug: 's', title: 'T', draft_body: '   ', current_version: 0 }];
    await assert.rejects(() => store.publish('o', 's', 'a'), /empty/);
});

test('saveDraft flips edited only when the body diverges from the seed', async () => {
    const seed = 'seed body';
    // Unchanged body → edited stays false
    oneQueue = [
        { organization_id: 'o', slug: 's', title: 'T', draft_body: seed, edited: false }, // saveDraft lookup
        { organization_id: 'o', slug: 's', title: 'T' },                                  // getDoc
    ];
    await store.saveDraft('o', 's', { body: seed }, 'a', { seedBody: seed });
    assert.strictEqual(calls.run.find(c => c.sql.includes('UPDATE isms_documents')).params[4], false);

    calls.run.length = 0;
    // Diverged body → edited true
    oneQueue = [
        { organization_id: 'o', slug: 's', title: 'T', draft_body: seed, edited: false },
        { organization_id: 'o', slug: 's', title: 'T' },
    ];
    await store.saveDraft('o', 's', { body: 'our own rules' }, 'a', { seedBody: seed });
    assert.strictEqual(calls.run.find(c => c.sql.includes('UPDATE isms_documents')).params[4], true);
});

test('edited never reverts once set, even if the body matches the seed again', async () => {
    oneQueue = [
        { organization_id: 'o', slug: 's', title: 'T', draft_body: 'x', edited: true },
        { organization_id: 'o', slug: 's', title: 'T' },
    ];
    await store.saveDraft('o', 's', { body: 'seed body' }, 'a', { seedBody: 'seed body' });
    assert.strictEqual(calls.run.find(c => c.sql.includes('UPDATE isms_documents')).params[4], true);
});

test('seedMissing uses DO NOTHING and skips malformed seeds', async () => {
    const n = await store.seedMissing('o', [
        { slug: 'a', title: 'A', body: 'b', controls: ['A.5.1'] },
        { slug: null, title: 'broken' },
        { title: 'no slug' },
    ]);
    assert.strictEqual(n, 1);
    assert.ok(calls.run[0].sql.includes('DO NOTHING'));
    assert.strictEqual(calls.run[0].params[4], JSON.stringify(['A.5.1']));
});

test('acknowledge is idempotent per (org, slug, version, user)', async () => {
    await store.acknowledge('o', 's', 3, 'u1', { ip: '1.2.3.4', userAgent: 'ua' });
    const ins = calls.run.find(c => c.sql.includes('INSERT INTO isms_acknowledgements'));
    assert.ok(ins.sql.includes('DO NOTHING'), 'double confirm must not error or duplicate');
    assert.deepEqual(ins.params, ['o', 's', 3, 'u1', '1.2.3.4', 'ua']);
});

test('setMeta clears on an explicit null and keeps on an absent key', async () => {
    // COALESCE could not tell the two apart, so the policy drawer's own way of
    // unassigning an owner (owner_user_id: null) silently kept the old owner.
    await store.setMeta('o', 's', { owner_user_id: null });
    const cleared = calls.run.find(c => c.sql.includes('UPDATE isms_documents'));
    assert.ok(cleared.sql.includes('owner_user_id = $3'), 'the column is written, not coalesced');
    assert.ok(!cleared.sql.includes('review_due_at'), 'an absent key is left alone');
    assert.deepEqual(cleared.params, ['o', 's', null]);

    calls.run.length = 0;
    await store.setMeta('o', 's', { owner_user_id: 'u7', review_due_at: '2027-01-31' });
    const both = calls.run.find(c => c.sql.includes('UPDATE isms_documents'));
    assert.deepEqual(both.params, ['o', 's', 'u7', '2027-01-31']);

    calls.run.length = 0;
    await store.setMeta('o', 's', {});
    assert.ok(!calls.run.some(c => c.sql.includes('UPDATE isms_documents')), 'nothing to write, nothing written');
});
