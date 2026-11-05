/**
 * The attribution of a media row: the dispatch context first, the signed-in
 * session second; 'direct-chat' only when no agent called the tool.
 *
 * Run: cd server && node --test core/tools/mediaUsage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mediaUsageFields } = require('./mediaUsage');

const REQ = { session: { user: { id: 'u-session', organizationId: 'org-session' } } };

test('an agent call names the agent, the conversation, the user and the org of its context', () => {
    assert.deepStrictEqual(
        mediaUsageFields(REQ, { userId: 'u1', orgId: 'org-1', agentId: 'agent-1', agentName: 'Designer', conversationId: 'c1' }),
        { user_id: 'u1', organization_id: 'org-1', agent_id: 'agent-1', agent_name: 'Designer', conversation_id: 'c1' },
    );
});

test('without a context the signed-in session is the user and the org, as direct chat', () => {
    assert.deepStrictEqual(mediaUsageFields(REQ), {
        user_id: 'u-session', organization_id: 'org-session', agent_id: null, agent_name: 'direct-chat', conversation_id: null,
    });
});

test('nothing known is null, never a guess; an empty org binding is no org', () => {
    assert.deepStrictEqual(mediaUsageFields(null, null), {
        user_id: null, organization_id: null, agent_id: null, agent_name: 'direct-chat', conversation_id: null,
    });
    assert.strictEqual(mediaUsageFields({ session: { user: { id: 'admin', organizationId: '' } } }).organization_id, null);
});

test('only the listed fields leave the context', () => {
    const fields = mediaUsageFields(REQ, /** @type {any} */ ({ userId: 'u1', session: { secret: 'x' }, req: {} }));
    assert.deepStrictEqual(Object.keys(fields).sort(), ['agent_id', 'agent_name', 'conversation_id', 'organization_id', 'user_id']);
});
