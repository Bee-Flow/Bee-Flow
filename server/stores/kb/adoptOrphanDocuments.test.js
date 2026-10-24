// @typecheck
/**
 * adoptOrphanDocuments: documents that predate the source model
 * (source_id IS NULL) get a source, scoped to ONE knowledge base. DB-free: the
 * dependencies are injected as recording fakes (no module mocking) and the emitted SQL is inspected.
 *
 * Run: cd server && node --test stores/kb/adoptOrphanDocuments.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const calls = [];      // every client.query / getOne: { sql, params }
let orphanRows = [];   // what the "documents" SELECT returns
let existingSource = null;

const client = {
    query: async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM knowledge_bases/.test(sql)) return { rows: [{ tenant_id: 'owner1' }] };
        if (/FROM documents/.test(sql)) return { rows: orphanRows };
        if (/SELECT id FROM kb_sources/.test(sql)) return { rows: existingSource ? [{ id: existingSource }] : [] };
        if (/INSERT INTO kb_sources/.test(sql)) return { rows: [{ id: 'new-src' }] };
        if (/UPDATE documents/.test(sql)) return { rowCount: params[1].length, rows: [] };
        return { rows: [] };
    },
};

let managed = null;
const adopter = require('./adoptOrphanDocuments')(async () => {}, {
    getOne: async (sql, params) => {
        calls.push({ sql, params });
        return orphanRows.length > 0 ? { ok: 1 } : null;
    },
    withTransaction: async (fn) => fn(client),
    managedParts: { managedInfoForKb: async () => managed },
});
const store = { adoptOrphanDocuments: adopter.adoptOrphanDocuments };

const KB = '11111111-1111-4111-8111-111111111111';

function reset(rows, existing = null) {
    calls.length = 0;
    orphanRows = rows;
    existingSource = existing;
    managed = null;
}

test('nothing to adopt: one cheap probe, no transaction work', async () => {
    reset([]);
    assert.strictEqual(await store.adoptOrphanDocuments(KB), 0);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].params, [KB]);
});

test('a legacy upload document gets the KB upload source', async () => {
    reset([{ id: 'doc-1', title: 'Handbook.pdf', source_type: 'upload', source_uri: 'Handbook.pdf' }]);
    assert.strictEqual(await store.adoptOrphanDocuments(KB), 1);

    const insert = calls.find(c => /INSERT INTO kb_sources/.test(c.sql));
    assert.ok(insert, 'a source was created');
    assert.strictEqual(insert.params[0], KB);
    assert.strictEqual(insert.params[1], 'upload');
    assert.strictEqual(insert.params[2], 'Uploaded files');
    assert.strictEqual(insert.params[4], 'owner1');

    const update = calls.find(c => /UPDATE documents/.test(c.sql));
    assert.deepStrictEqual(update.params, ['new-src', ['doc-1'], KB]);
});

test('an existing source with the same key is reused, not duplicated', async () => {
    reset([{ id: 'doc-1', title: 'a', source_type: 'upload', source_uri: 'a' }], 'old-src');
    await store.adoptOrphanDocuments(KB);
    assert.ok(!calls.some(c => /INSERT INTO kb_sources/.test(c.sql)));
    const update = calls.find(c => /UPDATE documents/.test(c.sql));
    assert.strictEqual(update.params[0], 'old-src');
});

test('every statement is scoped to the one KB and takes a per-KB lock', async () => {
    reset([{ id: 'doc-1', title: 'a', source_type: 'text', source_uri: null }]);
    await store.adoptOrphanDocuments(KB);
    assert.match(calls.find(c => /pg_advisory_xact_lock/.test(c.sql)).params[0], new RegExp(KB));
    for (const c of calls) {
        if (/FROM documents|FROM kb_sources|UPDATE documents/.test(c.sql)) {
            assert.match(c.sql, /knowledge_base_id = \$\d/, `scoped: ${c.sql.replace(/\s+/g, ' ').slice(0, 60)}`);
            assert.ok(c.params.includes(KB));
        }
    }
    // Only unassigned rows are ever touched.
    assert.match(calls.find(c => /UPDATE documents/.test(c.sql)).sql, /source_id IS NULL/);
});

test('a missing KB id adopts nothing', async () => {
    reset([{ id: 'doc-1', title: 'a', source_type: 'upload', source_uri: 'a' }]);
    assert.strictEqual(await store.adoptOrphanDocuments(''), 0);
    assert.strictEqual(calls.length, 0);
});

test('a managed (Solution stage) base is never adopted into, shell mode included', async () => {
    reset([{ id: 'doc-1', title: 'a', source_type: 'upload', source_uri: 'a' }]);
    managed = { stageId: 'st1', mode: 'shell' };
    assert.strictEqual(await store.adoptOrphanDocuments(KB), 0);
    assert.strictEqual(calls.length, 0, 'no read of documents, no write');
});
