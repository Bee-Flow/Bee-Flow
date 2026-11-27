/**
 * The automation module's part of "who uses this knowledge base?"
 * (./automation.js), through core/kb/kbUsage.js on the boot ladder's schema
 * (../kbUsage.testkit.js).
 *
 * Run: node --test core/kb/usage/automation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { failReads } = require('../../../testUtils/pgliteFaults');
const { usageForKb, scrubReferences } = require('../kbUsage');
const k = require('../kbUsage.testkit');

const { pg, db, KB1, everyKind, insertRow } = k;
k.useKbUsageDb(test);

test('a query that fails is PARTIAL too, and does not abandon the rest', async () => {
    await everyKind();
    const restore = await failReads(pg, 'automations', '57014', 'canceling statement due to statement timeout');
    try {
        const { rows, partial } = await usageForKb(KB1, { db });
        assert.deepStrictEqual(partial, ['automation']);
        assert.strictEqual(rows.length, 8, 'the other seven kinds were still asked');
    } finally { await restore(); }
});

test('the id reaches jsonpath as a VARIABLE: a quote in it is a character, not path syntax', async () => {
    // A kb id is a route parameter. Concatenated, a value carrying a quote
    // would close the string literal inside the jsonpath and be parsed as
    // path syntax.
    const odd = 'kb" || @ != "x';
    await insertRow(pg, 'automations', { id: 'au-odd', user_id: 'u1', title: 'Odd', definition_json: { a: { knowledgeBaseIds: [odd] } } });
    await insertRow(pg, 'automations', { id: 'au-plain', user_id: 'u1', title: 'Plain', definition_json: { a: { knowledgeBaseIds: [KB1] } } });
    const hit = await usageForKb(odd, { db });
    assert.deepStrictEqual(hit.partial, []);
    assert.deepStrictEqual(hit.rows.filter((r) => r.kind === 'automation').map((r) => r.id), ['au-odd']);
    assert.deepStrictEqual((await usageForKb('kb"1', { db })).rows, [], 'a stray quote matches nothing and breaks nothing');
});

test('automations are deliberately NOT rewritten', async () => {
    // The id sits at an unknown depth inside a definition that also encodes
    // the shape of a canvas; rewriting arbitrary JSON in place risks
    // corrupting an automation somebody spent an afternoon building.
    await everyKind();
    const before = (await pg.query(`SELECT definition_json FROM automations`)).rows;
    await scrubReferences(KB1, { db });
    assert.deepStrictEqual((await pg.query(`SELECT definition_json FROM automations`)).rows, before);
});
