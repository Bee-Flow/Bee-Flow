'use strict';

/**
 * The knowledge-upload source against a real Postgres (pglite). Each row the
 * source must leave out says why.
 *
 * Run: cd server && node --test automation/patterns/sources/documents.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { collectDocumentUploads, MANUAL_SOURCE_TYPES } = require('./documents');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 18, 0);
const win = { now: NOW, since: NOW - 90 * DAY };
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const { pg, db } = pgliteDb();

before(async () => {
    await pg.exec(`
        CREATE TABLE documents (
            id SERIAL PRIMARY KEY, tenant_id TEXT, knowledge_base_id TEXT, title TEXT,
            source_type TEXT DEFAULT 'text', source_uri TEXT, status TEXT DEFAULT 'processed',
            created_by TEXT, created_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    const rows = [
        // [createdBy, kb, title, sourceType, daysAgo, status]
        ['u1', 'kb-1', 'Weekly report week 40.xlsx', 'upload', 7, 'processed'],
        ['u1', 'kb-1', 'Weekly report week 41.xlsx', 'upload', 1, 'skipped'],     // queued upload: still the user's
        ['u1', 'kb-1', 'Weekly report week 41.xlsx', 'upload', 1, 'duplicate'],   // offered again
        ['u1', 'kb-2', 'Folder sync item.pdf', 'nextcloud_folder', 2, 'processed'], // connector refresh
        ['u1', 'kb-2', 'Automation output', 'automation_write', 2, 'processed'],         // an automation wrote it
        ['u1', 'kb-2', 'Pasted note', 'text', 2, 'processed'],                     // not an upload
        ['u1', 'kb-1', 'Old report.xlsx', 'upload', 120, 'processed'],            // outside the window
        ['u2', 'kb-1', 'Colleague report.xlsx', 'upload', 3, 'processed'],        // someone else
    ];
    for (const [u, kb, title, st, d, status] of rows) {
        await pg.query(
            `INSERT INTO documents (tenant_id, knowledge_base_id, title, source_type, source_uri, status, created_by, created_at)
             VALUES ('t1', $1, $2, $3, $2, $4, $5, $6)`,
            [kb, title, st, status, u, ago(d)]);
    }
});
after(() => pg.close());

test('only the user\'s own manual uploads, oldest first, as templates', async () => {
    const events = await collectDocumentUploads({ userId: 'u1', ...win, deps: { db } });
    assert.deepStrictEqual(events.map((e) => e.template), ['Weekly report <date>', 'Weekly report <date>']);
    assert.ok(events[0].ts < events[1].ts);
    for (const e of events) {
        assert.strictEqual(e.source, 'documents');
        assert.strictEqual(e.objectType, 'document');
        assert.strictEqual(e.app, 'beeflow');
        assert.strictEqual(e.verb, 'doc.uploaded');
        assert.match(e.sessionKey, /^kb:[0-9a-f]{16}$/);
    }
    assert.strictEqual(events[0].sessionKey, events[1].sessionKey, 'same knowledge base, same key');
    assert.ok(!JSON.stringify(events).includes('kb-1'));
});

test('the allow-list is uploads only', () => {
    assert.deepStrictEqual([...MANUAL_SOURCE_TYPES], ['upload']);
});

test('an install without the column reads as no uploads', async () => {
    const { PGlite } = require('@electric-sql/pglite');
    const bare = pgliteDb(new PGlite());
    try {
        await bare.pg.exec(`CREATE TABLE documents (id SERIAL PRIMARY KEY, title TEXT, source_type TEXT, created_at TIMESTAMPTZ)`);
        assert.deepStrictEqual(await collectDocumentUploads({ userId: 'u1', ...win, deps: { db: bare.db } }), []);
    } finally {
        await bare.pg.close();
    }
});
