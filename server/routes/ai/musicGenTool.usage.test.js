/**
 * generate_music bills the user and the organisation that called it, and the
 * calling agent and conversation when the dispatch context carries them.
 *
 * Run: cd server && node --test routes/ai/musicGenTool.usage.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { areaOf } = require('../../shared/usageAreas');

const rows = [];
const restore = installResolveStub({
    '../../stores/configStore': { getSecret: async () => 'key' },
    '../../core/providers': { googleAdapter: { generateMusic: async () => ({ audioBase64: 'YXVk', mimeType: 'audio/wav' }) } },
    '../../stores/storageStore': {
        isAvailable: () => true, buildKey: (...parts) => parts.join('/'), uploadFile: async () => {}, buildProxyUrl: (k) => `/files/${k}`,
    },
    '../../stores/usageStore': { logUsage: async (row) => { rows.push(row); } },
});
after(() => restore());

const { executeMusicGenTool } = require('./musicGenTool');

const REQ = /** @type {any} */ ({ session: { user: { id: 'u-session', organizationId: 'org-session' } } });

test('an agent call is billed to the user and org of its context, under the agent', async () => {
    rows.length = 0;
    const out = await executeMusicGenTool({ prompt: 'jazz' }, () => {}, REQ, null, { userId: 'u1', orgId: 'org-1', agentId: 'agent-1', conversationId: 'c1' });
    assert.strictEqual(out.success, true);
    const row = rows[0];
    assert.strictEqual(row.user_id, 'u1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.agent_id, 'agent-1');
    assert.strictEqual(row.conversation_id, 'c1');
    assert.notStrictEqual(areaOf(row.source), 'other');
});

test('without a context the session user and org are billed', async () => {
    rows.length = 0;
    await executeMusicGenTool({ prompt: 'jazz' }, () => {}, REQ, null);
    assert.strictEqual(rows[0].user_id, 'u-session');
    assert.strictEqual(rows[0].organization_id, 'org-session');
    assert.strictEqual(rows[0].agent_name, 'direct-chat');
});
