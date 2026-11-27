/**
 * The webpages module's part of "who uses this knowledge base?"
 * (./webpages.js), through core/kb/kbUsage.js on the boot ladder's schema
 * (../kbUsage.testkit.js).
 *
 * Run: node --test core/kb/usage/webpages.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { hideTable, failReads } = require('../../../testUtils/pgliteFaults');
const { usageSummary, scrubReferences } = require('../kbUsage');
const k = require('../kbUsage.testkit');

const { pg, db, KB1, agent, kbIdsOf, everyKind, insertRow } = k;
k.useKbUsageDb(test);

test('summary: counts per kind, per knowledge base; a kind with no count is absent rather than zero', async () => {
    await agent('a', [KB1]);
    await agent('b', [KB1, 'kb3']);
    await agent('c', [KB1]);
    await insertRow(pg, 'webpages', { id: 'w', user_id: 'u1', name: 'W', knowledge_base_ids: [KB1] });
    const out = await usageSummary([KB1, 'kb2'], { db });
    assert.deepStrictEqual(out[KB1].counts, { agent: 3, webpage: 1 });
    // The overview renders a pill per entry; a zero would draw "0 agents".
    assert.deepStrictEqual(out.kb2.counts, {}, 'a base nothing uses counts nothing');
});

test('one consumer failing does not abandon the others', async () => {
    // The base is going either way, and a half-scrubbed install is the
    // worst of the three outcomes.
    await everyKind();
    const restore = await failReads(pg, 'projects', '55P03', 'lock not available');
    try {
        const out = await scrubReferences(KB1, { db });
        assert.strictEqual(out.project, 0);
        assert.strictEqual(out.webpage, 1, 'the rest still ran');
    } finally { await restore(); }
    assert.deepStrictEqual(await kbIdsOf('webpages', 'w1'), []);
});

test('a table that is not installed is skipped, not an error', async () => {
    await agent('ag1', [KB1]);
    const restore = await hideTable(pg, 'webpages');
    try {
        const out = await scrubReferences(KB1, { db });
        assert.strictEqual(out.agent, 1);
        assert.strictEqual(out.webpage, 0);
    } finally { await restore(); }
});
