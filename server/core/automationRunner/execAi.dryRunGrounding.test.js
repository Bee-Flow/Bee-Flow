// @typecheck
/**
 * RM-6: an AI step's knowledge-base grounding in a DRY RUN.
 *
 * The search used to be skipped in a dry run while the model was still called
 * for real, so the answer was made without its reference material and a
 * switch behind it could take a branch the live run never would. The search
 * is a read: a dry run now performs it exactly as live (with the same
 * per-asker filter), and when it cannot run the result says so
 * (`unavailable`), which execAi turns into `_dryRunNoKnowledge` + a
 * synthesised flag (asserted end to end in execAi.kb.test.js).
 *
 * Run: node --test core/automationRunner/execAi.dryRunGrounding.test.js
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { groundAiStepWithKB } = require('./aiStepGrounding');

// Both the per-asker filter and the search come in through GroundingDeps.
const filtered = [];
const searches = [];
let searchError = null;
const deps = /** @type {import('./aiStepGrounding').GroundingDeps} */ (/** @type {unknown} */ ({
    kbVisibility: () => ({
        async filterKbIdsForUser(ids, who) { filtered.push({ ids, who }); return ids.filter((id) => id !== 'kb_foreign'); },
    }),
    knowledgeSearch: () => ({
        async quickKBSearch(userId, kbIds, query) {
            searches.push({ userId, kbIds, query });
            if (searchError) throw searchError;
            return [{ title: 'Refund policy', content: 'Refunds within 30 days.' }];
        },
    }),
}));
const CTX = { userId: 'u1', orgId: 'org1' };
const step = { id: 'ai_1', knowledgeBaseIds: ['kb_ok', 'kb_foreign'] };

beforeEach(() => { searches.length = 0; filtered.length = 0; searchError = null; });

test('a dry run calls the KB search, through the same per-asker filter as live', async () => {
    for (const mode of ['dry_run', 'live']) {
        searches.length = 0;
        const g = await groundAiStepWithKB(step, CTX, 'refund allowed?', mode, null, deps);
        assert.deepEqual(searches.map((s) => s.kbIds), [['kb_ok']], `${mode}: the foreign base is filtered out`);
        assert.match(g.context, /Refunds within 30 days/);
        assert.equal(g.unavailable, undefined);
    }
});

test('a search that fails degrades to no grounding and says it was unavailable', async () => {
    searchError = new Error('vector store down');
    const g = await groundAiStepWithKB(step, CTX, 'refund allowed?', 'dry_run', null, deps);
    assert.equal(g.context, '');
    assert.equal(g.unavailable, true);
});

test('no bases, or none the owner may read, is not "unavailable": live answers the same way', async () => {
    const none = await groundAiStepWithKB({ id: 'ai_1' }, CTX, 'q', 'dry_run', null, deps);
    assert.equal(none.unavailable, undefined);
    const foreign = await groundAiStepWithKB({ id: 'ai_1', knowledgeBaseIds: ['kb_foreign'] }, CTX, 'q', 'dry_run', null, deps);
    assert.equal(foreign.unavailable, undefined);
    assert.equal(searches.length, 0);
});
