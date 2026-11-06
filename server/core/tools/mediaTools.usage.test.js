/**
 * The media tools (image, video, ElevenLabs music/speech/effects) bill the
 * user and the organisation that called them, and name the calling agent and
 * conversation when the dispatch context carries them. Before, every row had
 * no user and no org (invisible to an org's report) and said 'direct-chat'
 * also when an agent called the tool.
 *
 * Every media row spreads mediaUsageFields(req, caller) and adds its own
 * source; this test holds those attribution fields for the contexts the tools
 * are called with, and that each tool's source lands in a known usage area.
 *
 * Run: cd server && node --test core/tools/mediaTools.usage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { areaOf } = require('../../shared/usageAreas');
const { mediaUsageFields } = require('./mediaUsage');

const REQ = { session: { user: { id: 'u-session', organizationId: 'org-session' } } };
const AGENT = { userId: 'u1', orgId: 'org-1', agentId: 'agent-1', conversationId: 'conv-1' };
const SOURCES = ['image_generation', 'video_generation', 'elevenlabs_music', 'elevenlabs_tts', 'elevenlabs_sfx'];

/** A media row as the tools build it: the attribution fields plus the tool's source. */
const rowOf = (source, req, caller) => ({ ...mediaUsageFields(req, caller), source });

function assertAgentRow(row, source) {
    assert.strictEqual(row.source, source);
    assert.strictEqual(row.user_id, 'u1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.agent_id, 'agent-1');
    assert.notStrictEqual(row.agent_name, 'direct-chat', 'an agent called it');
    assert.strictEqual(row.conversation_id, 'conv-1');
    assert.notStrictEqual(areaOf(row.source), 'other');
}

test('an agent call is billed to the user and org of its context, under the agent, for every media tool', () => {
    for (const source of SOURCES) assertAgentRow(rowOf(source, REQ, AGENT), source);
});

test('without a context the session user and org are billed, as direct chat', () => {
    for (const source of SOURCES) {
        const row = rowOf(source, REQ);
        assert.strictEqual(row.user_id, 'u-session');
        assert.strictEqual(row.organization_id, 'org-session');
        assert.strictEqual(row.agent_name, 'direct-chat');
    }
});
