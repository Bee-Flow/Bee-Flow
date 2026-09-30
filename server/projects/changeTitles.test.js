'use strict';

/**
 * Titles for the change feed, resolved at read time (projects/changeTitles.js),
 * against a real Postgres (pglite) with the item tables as far as the lookup
 * reads them.
 *
 * Pinned: only ids asked for AND still filed in this project come back;
 * archived and non-document rows of studio_documents do not; a missing table
 * (an install without that module) answers nothing instead of failing; an
 * unknown item type is never queried.
 *
 * Run: cd server && node --test projects/changeTitles.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { makeChangeTitles } = require('./changeTitles');

let pg;
let titles;
const queries = [];
const warnings = [];

test.before(async () => {
    pg = new PGlite();
    await pg.exec(`
        CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT);
        CREATE TABLE studio_documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT,
            kind TEXT NOT NULL DEFAULT 'document', archived BOOLEAN NOT NULL DEFAULT false);
        INSERT INTO notebooks VALUES ('n1', 'Notes', 'p1'), ('n2', 'Elsewhere', 'p2');
        INSERT INTO studio_documents (id, name, project_id, kind, archived) VALUES
            ('d1', 'Brief', 'p1', 'document', false),
            ('d2', 'Old brief', 'p1', 'document', true),
            ('t1', 'A template', 'p1', 'template', false);
    `);
    titles = makeChangeTitles({
        query: async (sql, params) => { queries.push(sql); return pg.query(sql, params); },
    }, { log: { warn: (...a) => warnings.push(a.join(' ')) } });
});
test.after(async () => { await pg.close(); });

test('names only the asked-for items that are still in this project', async () => {
    const out = await titles.resolveTitles('p1', [
        { type: 'notebook', id: 'n1' }, { type: 'notebook', id: 'n2' },
        { type: 'document', id: 'd1' }, { type: 'document', id: 'd2' }, { type: 'document', id: 't1' },
    ]);
    assert.deepStrictEqual(Object.fromEntries(out), { 'notebook:n1': { title: 'Notes' }, 'document:d1': { title: 'Brief' } });
});

test('a missing table answers nothing; unknown types are never queried', async () => {
    queries.length = 0;
    const out = await titles.resolveTitles('p1', [{ type: 'meeting', id: 'm1' }, { type: 'automation', id: 'a1' }, null, { type: 'notebook' }]);
    assert.strictEqual(out.size, 0);
    assert.strictEqual(queries.length, 1);
    assert.match(queries[0], /FROM transcriptions/);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual((await titles.resolveTitles('', [{ type: 'notebook', id: 'n1' }])).size, 0);
    assert.strictEqual((await titles.resolveTitles('p1', 'n1')).size, 0);
});
