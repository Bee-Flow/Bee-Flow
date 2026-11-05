/**
 * The ledger row of the webpage AI bridge (chat and stream): the author pays,
 * the signed-in viewer of the page is the actor, an anonymous visitor is null.
 * The ledger sink is handed to writeBridgeUsage, the writer behind
 * logBridgeUsage.
 *
 * Run: cd server && node --test routes/webpagesPreviewAi.usage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { areaOf } = require('../shared/usageAreas');
const { writeBridgeUsage } = require('./webpagesPreviewAi');

const rows = [];
const sink = { logUsage: async (row) => { rows.push(row); } };

const CTX = { webpage: { name: 'Support page' }, authorUserId: 'author-1', authorOrgId: 'org-1' };

test('the author pays and the signed-in viewer is the actor', () => {
    rows.length = 0;
    writeBridgeUsage({
        ctx: CTX, claims: { webpageId: 'wp-1', viewerUserId: 'viewer-1' }, modelId: 'model-1',
        fields: { prompt_tokens: 3, completion_tokens: 2 }, t0: Date.now(),
    }, sink);
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.user_id, 'author-1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.actor_user_id, 'viewer-1');
    assert.strictEqual(row.agent_id, 'wp-1');
    assert.strictEqual(row.prompt_tokens, 3);
    assert.strictEqual(row.source, 'webpage_bridge_ai');
    assert.notStrictEqual(areaOf(row.source), 'other');
});

test('an anonymous visitor is no actor', () => {
    rows.length = 0;
    writeBridgeUsage({ ctx: CTX, claims: { webpageId: 'wp-1', viewerUserId: null }, modelId: 'model-1', fields: {}, t0: Date.now() }, sink);
    assert.strictEqual(rows[0].actor_user_id, null);
});
