/**
 * A builder turn writes one usage row (source automation_builder): the
 * person, their organisation, the automation being built, the builder session
 * and the tokens of every round. Before, the builder chat wrote nothing.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/turnClosing.usage.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { areaOf } = require('../../../shared/usageAreas');
const { meterBuilderTurn, addRoundUsage } = require('./turnClosing');

const rows = [];
// The ledger sink, handed to the meter instead of the usage store.
const sink = { logUsage: async (row) => { rows.push(row); } };

test('the turn is billed to the person and the org, under the automation and the session', () => {
    rows.length = 0;
    meterBuilderTurn(/** @type {any} */ ({
        userId: 'u1', userOrgForTiers: 'org-1', modelId: 'model-build',
        usageTotals: { prompt: 900, completion: 120, cached: 400, cacheCreation: 50, rounds: 3 },
        draftWrap: { automationId: 'auto-1', builderSessionId: 'bs-1' },
    }), sink);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.source, 'automation_builder');
    assert.equal(row.user_id, 'u1');
    assert.equal(row.organization_id, 'org-1');
    assert.equal(row.agent_id, 'auto-1');
    assert.equal(row.conversation_id, 'bs-1');
    assert.equal(row.model, 'model-build');
    assert.equal(row.prompt_tokens, 900);
    assert.equal(row.completion_tokens, 120);
    assert.equal(row.cached_tokens, 400);
    assert.notEqual(areaOf(row.source), 'other');
});

test('a Claude turn keeps the uncached prompt flag and the 1h cache-write split of its rounds', () => {
    rows.length = 0;
    const { normalizeUsage } = require('../../../core/providers/usageNormalizer');
    const { accumulateUsage } = require('../../../usecases/ai/automationBuilder/chatTurnLoop');
    // Two rounds as the Claude adapter reports them: input_tokens is the
    // uncached remainder, the cache writes carry no TTL breakdown (1h).
    const round = () => normalizeUsage('claude', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 });
    const turn = /** @type {any} */ ({
        userId: 'u1', userOrgForTiers: 'org-1', modelId: 'claude-sonnet-4-5',
        usageTotals: { prompt: 0, completion: 0, cached: 0, cacheCreation: 0, rounds: 0 },
        draftWrap: { automationId: 'auto-1', builderSessionId: 'bs-3' },
    });
    for (let i = 0; i < 2; i++) {
        const usage = round();
        accumulateUsage(turn.usageTotals, usage);
        addRoundUsage(turn, usage);
    }
    meterBuilderTurn(turn, sink);
    const row = rows[0];
    assert.equal(row.prompt_includes_cache, false, 'the prompt count is the uncached remainder');
    assert.equal(row.prompt_tokens, 200);
    assert.equal(row.cached_tokens, 20000);
    assert.equal(row.cache_creation_tokens, 4000);
    assert.equal(row.cache_creation_1h_tokens, 4000);
    assert.equal(row.cache_creation_5m_tokens, 0);
    assert.equal(row.completion_tokens, 100);
});

test('a draft with no automation yet still logs, without an object id', () => {
    rows.length = 0;
    meterBuilderTurn(/** @type {any} */ ({
        userId: 'u1', userOrgForTiers: null, modelId: 'm',
        usageTotals: { prompt: 1, completion: 1, cached: 0, cacheCreation: 0, rounds: 1 },
        draftWrap: { automationId: null, builderSessionId: 'bs-2' },
    }), sink);
    assert.equal(rows[0].agent_id, null);
    assert.equal(rows[0].organization_id, null);
});
