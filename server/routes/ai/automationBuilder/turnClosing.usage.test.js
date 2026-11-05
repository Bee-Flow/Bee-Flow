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
const { installResolveStub } = require('../../../testUtils/stubRequire');
const { areaOf } = require('../../../shared/usageAreas');

const rows = [];
const restore = installResolveStub({
    // The sink as core/llm/surfaceUsage.js requires it.
    '../../stores/usageStore': { logUsage: async (row) => { rows.push(row); } },
});
test.after(() => restore());

const { meterBuilderTurn } = require('./turnClosing');

test('the turn is billed to the person and the org, under the automation and the session', () => {
    rows.length = 0;
    meterBuilderTurn(/** @type {any} */ ({
        userId: 'u1', userOrgForTiers: 'org-1', modelId: 'model-build',
        usageTotals: { prompt: 900, completion: 120, cached: 400, cacheCreation: 50, rounds: 3 },
        draftWrap: { automationId: 'auto-1', builderSessionId: 'bs-1' },
    }));
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

test('a draft with no automation yet still logs, without an object id', () => {
    rows.length = 0;
    meterBuilderTurn(/** @type {any} */ ({
        userId: 'u1', userOrgForTiers: null, modelId: 'm',
        usageTotals: { prompt: 1, completion: 1, cached: 0, cacheCreation: 0, rounds: 1 },
        draftWrap: { automationId: null, builderSessionId: 'bs-2' },
    }));
    assert.equal(rows[0].agent_id, null);
    assert.equal(rows[0].organization_id, null);
});
