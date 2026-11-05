/**
 * The ledger row of the webpage AI bridge (chat and stream): the author pays,
 * the signed-in viewer of the page is the actor, an anonymous visitor is null.
 *
 * Run: cd server && node --test routes/webpagesPreviewAi.usage.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');
const { areaOf } = require('../shared/usageAreas');

const rows = [];
const restore = installResolveStub({
    '../stores/usageStore': { logUsage: async (row) => { rows.push(row); } },
});
after(() => restore());

const { _logBridgeUsage } = require('./webpagesPreviewAi');

const CTX = { webpage: { name: 'Support page' }, authorUserId: 'author-1', authorOrgId: 'org-1' };

test('the author pays and the signed-in viewer is the actor', () => {
    rows.length = 0;
    _logBridgeUsage(CTX, { webpageId: 'wp-1', viewerUserId: 'viewer-1' }, 'model-1', { prompt_tokens: 3, completion_tokens: 2 }, Date.now());
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.user_id, 'author-1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.actor_user_id, 'viewer-1');
    assert.strictEqual(row.agent_id, 'wp-1');
    assert.strictEqual(row.prompt_tokens, 3);
    assert.notStrictEqual(areaOf(row.source), 'other');
});

test('an anonymous visitor is no actor', () => {
    rows.length = 0;
    _logBridgeUsage(CTX, { webpageId: 'wp-1', viewerUserId: null }, 'model-1', {}, Date.now());
    assert.strictEqual(rows[0].actor_user_id, null);
});
