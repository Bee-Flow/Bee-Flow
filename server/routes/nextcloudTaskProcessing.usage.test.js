/**
 * Every model call of the Nextcloud assistant writes a usage row: the linked
 * Bee Flow user, the organisation, source `nextcloud_assistant`, the model and
 * the tokens. Before, the assistant called the model and wrote nothing.
 *
 * Run: cd server && node --test routes/nextcloudTaskProcessing.usage.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');
const { areaOf } = require('../shared/usageAreas');

const rows = [];
const restore = installResolveStub({
    '../../stores/usageStore': { logUsage: async (row) => { rows.push(row); } },
});
after(() => restore());

const { meterAssistantCall } = require('./nextcloudTaskProcessing');

test('a call is billed to the linked user and the organisation', () => {
    rows.length = 0;
    meterAssistantCall({
        userId: 'u1', org: { id: 'org-1' }, modelId: 'model-std',
        completion: { content: 'ok', usage: { prompt_tokens: 11, completion_tokens: 4 } }, startedAt: Date.now(),
    });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, 'u1');
    assert.equal(row.organization_id, 'org-1');
    assert.equal(row.source, 'nextcloud_assistant');
    assert.equal(row.model, 'model-std');
    assert.equal(row.prompt_tokens, 11);
    assert.notEqual(areaOf(row.source), 'other');
    assert.ok(!JSON.stringify(row).includes('"ok"'), 'no answer text in the row');
});

test('a reply without usage (or a bare string) is still a zero-token row', () => {
    rows.length = 0;
    meterAssistantCall({ userId: null, org: { id: 'org-1' }, modelId: 'model-std', completion: 'plain text', startedAt: Date.now() });
    assert.equal(rows[0].prompt_tokens, 0);
    assert.equal(rows[0].user_id, null);
});
