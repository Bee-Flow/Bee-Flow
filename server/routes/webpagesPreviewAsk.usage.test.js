/**
 * The ledger row of the webpage AI bridge's agentic ask (POST /:id/ai/ask):
 * the page's author pays (`user_id`, `organization_id`), the signed-in viewer
 * who asked is the actor (`actor_user_id`), and the webpage stays the object
 * (`agent_id`). The row is written by logAskUsage, the step the ask route ends
 * with; the ledger sink is handed to it. The route itself (rounds, tools, the
 * PII gate) is covered by webpagesPreview.toolPiiGate.test.js.
 *
 * Run: cd server && node --test routes/webpagesPreviewAsk.usage.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { areaOf } = require('../shared/usageAreas');
const { logAskUsage } = require('./webpagesPreviewAsk');

const rows = [];
const sink = { logUsage: async (row) => { rows.push(row); } };

const CTX = { webpage: { name: 'Support page' }, authorUserId: 'author-1', authorOrgId: 'org-1' };

test('the ask is logged under the author with the viewer as actor', () => {
    rows.length = 0;
    logAskUsage({
        ctx: CTX, webpageId: 'wp-1', viewerUserId: 'viewer-1', modelId: 'model-1',
        usage: { prompt_tokens: 30, completion_tokens: 5 }, t0: Date.now(),
    }, sink);
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.user_id, 'author-1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.actor_user_id, 'viewer-1');
    assert.strictEqual(row.agent_id, 'wp-1');
    assert.strictEqual(row.source, 'webpage_bridge_ai_agentic');
    assert.strictEqual(row.prompt_tokens, 30);
    assert.notStrictEqual(areaOf(row.source), 'other');
});

test('an anonymous visitor is no actor', () => {
    rows.length = 0;
    logAskUsage({ ctx: CTX, webpageId: 'wp-1', viewerUserId: null, modelId: 'model-1', usage: null, t0: Date.now() }, sink);
    assert.strictEqual(rows[0].actor_user_id, null);
    assert.strictEqual(rows[0].prompt_tokens, 0);
});
