'use strict';

/**
 * Which of a project's knowledge bases a member may search
 * (core/kb/projectFilesKb.js).
 *
 * Proven:
 *   - the project's files base is kept for a member even though the ordinary
 *     per-asker filter would drop it (it is never published);
 *   - it is only kept when it really IS this project's files base: right
 *     source kind, the id the project records, the same organisation;
 *   - every other base still goes through the asker's own filter, and only
 *     what that filter keeps survives;
 *   - a "Test as" preview gets no files base;
 *   - a lookup failure leaves the files out rather than letting them in.
 *
 * Run: cd server && node --test core/kb/projectFilesKb.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    PROJECT_FILES_SOURCE_KIND, filesKbIdOf, isProjectFilesKb, searchableProjectKbIds,
} = require('./projectFilesKb');

const FILES = '11111111-1111-4111-8111-111111111111';
const project = (over = {}) => ({
    id: 'p1', organizationId: 'org1', filesKbId: FILES, knowledgeBaseIds: ['kbA', FILES, 'kbB'], ...over,
});
const filesRow = (over = {}) => ({ id: FILES, source_kind: PROJECT_FILES_SOURCE_KIND, organization_id: 'org1', ...over });
const storeWith = (row) => ({ calls: [], async getKB(id) { this.calls.push(id); return row && String(row.id) === id ? row : null; } });

test('the files base is kept for a member, the rest goes through the asker\'s filter', async () => {
    const seen = [];
    const out = await searchableProjectKbIds(project(), {
        filterAttached: async (ids) => { seen.push(ids); return ids.filter(id => id === 'kbB'); },
        deps: { kbStore: storeWith(filesRow()) },
    });
    assert.deepStrictEqual(seen, [['kbA', 'kbB']], 'the files base is not handed to the ordinary filter');
    assert.deepStrictEqual(out, [FILES, 'kbB']);
});

test('a base that is not this project\'s files base is not let through', async () => {
    const cases = [
        ['another kind', filesRow({ source_kind: 'manual' })],
        ['another organisation', filesRow({ organization_id: 'org2' })],
        ['a missing row', null],
    ];
    for (const [label, row] of cases) {
        const out = await searchableProjectKbIds(project(), {
            filterAttached: async (ids) => ids,
            deps: { kbStore: storeWith(row) },
        });
        assert.deepStrictEqual(out, ['kbA', 'kbB'], label);
    }
});

test('a "Test as" preview gets no files base and does not even look it up', async () => {
    const store = storeWith(filesRow());
    const out = await searchableProjectKbIds(project(), {
        filterAttached: async (ids) => ids, includeFiles: false, deps: { kbStore: store },
    });
    assert.deepStrictEqual(out, ['kbA', 'kbB']);
    assert.deepStrictEqual(store.calls, []);
});

test('a failed lookup leaves the files out', async () => {
    const out = await searchableProjectKbIds(project(), {
        filterAttached: async (ids) => ids,
        deps: { kbStore: { getKB: async () => { throw new Error('db down'); } } },
    });
    assert.deepStrictEqual(out, ['kbA', 'kbB']);
});

test('a project without a files base behaves exactly as before', async () => {
    const out = await searchableProjectKbIds(project({ filesKbId: null, knowledgeBaseIds: ['kbA'] }), {
        filterAttached: async (ids) => ids,
        deps: { kbStore: { getKB: async () => { throw new Error('must not be called'); } } },
    });
    assert.deepStrictEqual(out, ['kbA']);
    assert.deepStrictEqual(await searchableProjectKbIds(null, { filterAttached: async (ids) => ids }), []);
});

test('the files base is found even when it is missing from the stored list', async () => {
    const out = await searchableProjectKbIds(project({ knowledgeBaseIds: ['kbA'] }), {
        filterAttached: async () => [],
        deps: { kbStore: storeWith(filesRow()) },
    });
    assert.deepStrictEqual(out, [FILES]);
});

test('org-less project and org-less base match; the id must be the recorded one', () => {
    const personal = project({ organizationId: '' });
    assert.strictEqual(isProjectFilesKb(filesRow({ organization_id: null }), personal), true);
    assert.strictEqual(isProjectFilesKb(filesRow({ id: 'other' }), project()), false);
    assert.strictEqual(filesKbIdOf({ filesKbId: '' }), null);
    assert.strictEqual(filesKbIdOf(undefined), null);
});
