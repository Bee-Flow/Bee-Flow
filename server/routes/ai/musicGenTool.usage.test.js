/**
 * generate_music bills the user and the organisation that called it, and the
 * calling agent and conversation when the dispatch context carries them.
 * The row is written by logMusicUsage, the step executeMusicGenTool ends
 * with; the ledger sink is handed to it.
 *
 * Run: cd server && node --test routes/ai/musicGenTool.usage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { areaOf } = require('../../shared/usageAreas');
const { logMusicUsage } = require('./musicGenTool');

const rows = [];
const sink = { logUsage: async (row) => { rows.push(row); } };

const REQ = { session: { user: { id: 'u-session', organizationId: 'org-session' } } };

test('an agent call is billed to the user and org of its context, under the agent', async () => {
    rows.length = 0;
    await logMusicUsage(REQ, { userId: 'u1', orgId: 'org-1', agentId: 'agent-1', conversationId: 'c1' }, 'jazz', sink);
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.user_id, 'u1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.agent_id, 'agent-1');
    assert.strictEqual(row.conversation_id, 'c1');
    assert.strictEqual(row.source, 'music_generation');
    assert.strictEqual(row.prompt_tokens, 'jazz'.length);
    assert.notStrictEqual(areaOf(row.source), 'other');
});

test('without a context the session user and org are billed', async () => {
    rows.length = 0;
    await logMusicUsage(REQ, null, 'jazz', sink);
    assert.strictEqual(rows[0].user_id, 'u-session');
    assert.strictEqual(rows[0].organization_id, 'org-session');
    assert.strictEqual(rows[0].agent_name, 'direct-chat');
});

test('a failing sink never throws into the tool', async () => {
    await logMusicUsage(REQ, null, 'jazz', { logUsage: async () => { throw new Error('db down'); } });
});
