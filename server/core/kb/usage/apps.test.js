/**
 * The apps module's part of "who uses this knowledge base?" (./apps.js),
 * through core/kb/kbUsage.js on the boot ladder's schema (../kbUsage.testkit.js).
 *
 * Run: node --test core/kb/usage/apps.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { hideTable } = require('../../../testUtils/pgliteFaults');
const { usageForKb, usageSummary, scrubReferences } = require('../kbUsage');
const k = require('../kbUsage.testkit');

const { pg, db, KB1, everyKind, insertRow } = k;
k.useKbUsageDb(test);

test('a consumer table that does not exist is PARTIAL, never zero', async () => {
    // "The apps table is not on this install" is not the same statement as
    // "no app uses this", and only one of them is safe to delete on.
    const restore = await hideTable(pg, 'studio_apps');
    try {
        const { rows, partial } = await usageForKb(KB1, { db });
        assert.deepStrictEqual(rows, []);
        assert.deepStrictEqual(partial, ['app']);
    } finally { await restore(); }
});

test('an app is found through its PUBLISHED definition, not only its draft', async () => {
    // An app that uses the base only in the version people actually run still
    // breaks when it goes.
    await insertRow(pg, 'studio_apps', { id: 'draft', user_id: 'u1', name: 'D', definition: { x: { knowledgeBaseIds: [KB1] } }, published_definition: null });
    await insertRow(pg, 'studio_apps', { id: 'published', user_id: 'u1', name: 'P', definition: {}, published_definition: { x: { knowledgeBaseIds: [KB1] } } });
    await insertRow(pg, 'studio_apps', { id: 'neither', user_id: 'u1', name: 'N', definition: { x: { knowledgeBaseIds: ['kb2'] } } });
    const { rows } = await usageForKb(KB1, { db });
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['draft', 'published']);
});

test('summary: a missing table is partial here too', async () => {
    const restore = await hideTable(pg, 'studio_apps');
    try {
        const out = await usageSummary([KB1], { db });
        assert.deepStrictEqual(out[KB1].partial, ['app']);
    } finally { await restore(); }
});

test('apps are deliberately NOT rewritten', async () => {
    // The id sits at an unknown depth inside a definition that also encodes
    // the shape of a canvas; rewriting arbitrary JSON in place risks
    // corrupting what somebody spent an afternoon building.
    await everyKind();
    const beforeApp = (await pg.query(`SELECT published_definition FROM studio_apps`)).rows;
    await scrubReferences(KB1, { db });
    assert.deepStrictEqual((await pg.query(`SELECT published_definition FROM studio_apps`)).rows, beforeApp);
});
