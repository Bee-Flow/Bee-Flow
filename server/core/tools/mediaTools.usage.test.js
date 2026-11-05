/**
 * The media tools (image, video, ElevenLabs music/speech/effects) bill the
 * user and the organisation that called them, and name the calling agent and
 * conversation when the dispatch context carries them. Before, every row had
 * no user and no org (invisible to an org's report) and said 'direct-chat'
 * also when an agent called the tool.
 *
 * The providers and the storage are stubbed; the tools are the real ones.
 *
 * Run: cd server && node --test core/tools/mediaTools.usage.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { areaOf } = require('../../shared/usageAreas');

const rows = [];
const restore = installResolveStub({
    '../../stores/configStore': { getSecret: async () => 'key' },
    '../providers': {
        googleAdapter: {
            generateImage: async () => ({ imageBase64: 'aW1n', mimeType: 'image/png' }),
            generateVideo: async () => ({ videoBase64: 'dmlk', mimeType: 'video/mp4' }),
        },
    },
    '../providers/elevenlabs': {
        generateSong: async () => ({ audioBase64: 'YXVk', mimeType: 'audio/mpeg' }),
        textToSpeech: async () => ({ audioBase64: 'YXVk', mimeType: 'audio/mpeg' }),
        generateSoundEffect: async () => ({ audioBase64: 'YXVk', mimeType: 'audio/mpeg' }),
    },
    '../../stores/storageStore': {
        isAvailable: () => true, buildKey: (...parts) => parts.join('/'), uploadFile: async () => {}, buildProxyUrl: (k) => `/files/${k}`,
    },
    '../../stores/usageStore': { logUsage: async (row) => { rows.push(row); } },
});
after(() => restore());

const { executeImageGenTool } = require('./imageGenTool');
const { executeVideoGenTool } = require('./videoGenTool');
const { runElevenLabsTool } = require('./elevenLabsTools');

const REQ = { session: { user: { id: 'u-session', organizationId: 'org-session' } } };
const AGENT = { userId: 'u1', orgId: 'org-1', agentId: 'agent-1', conversationId: 'conv-1' };
const send = () => {};
const flush = () => new Promise((r) => setImmediate(r));

function assertAgentRow(row, source) {
    assert.strictEqual(row.source, source);
    assert.strictEqual(row.user_id, 'u1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.agent_id, 'agent-1');
    assert.notStrictEqual(row.agent_name, 'direct-chat', 'an agent called it');
    assert.strictEqual(row.conversation_id, 'conv-1');
    assert.notStrictEqual(areaOf(row.source), 'other');
}

test('image: an agent call is billed to the user and org of its context, under the agent', async () => {
    rows.length = 0;
    const out = await executeImageGenTool({ prompt: 'a bee' }, null, send, /** @type {any} */ (REQ), AGENT);
    assert.strictEqual(out.success, true);
    assertAgentRow(rows[0], 'image_generation');
});

test('image: without a context the session user and org are billed, as direct chat', async () => {
    rows.length = 0;
    await executeImageGenTool({ prompt: 'a bee' }, null, send, /** @type {any} */ (REQ));
    assert.strictEqual(rows[0].user_id, 'u-session');
    assert.strictEqual(rows[0].organization_id, 'org-session');
    assert.strictEqual(rows[0].agent_name, 'direct-chat');
});

test('video: billed to the caller', async () => {
    rows.length = 0;
    const out = await executeVideoGenTool({ prompt: 'a bee' }, send, /** @type {any} */ (REQ), null, AGENT);
    assert.strictEqual(out.success, true);
    assertAgentRow(rows[0], 'video_generation');
});

test('ElevenLabs: music, speech and effects are billed to the caller', async () => {
    for (const [tool, args] of [['elevenlabs_music', { prompt: 'jazz' }], ['elevenlabs_tts', { text: 'hello' }], ['elevenlabs_sfx', { prompt: 'buzz' }]]) {
        rows.length = 0;
        const out = await runElevenLabsTool({ toolName: tool, toolArgs: args, send, req: /** @type {any} */ (REQ), nanoBananaSettings: null, caller: AGENT });
        await flush();
        assert.strictEqual(out.success, true, tool);
        assertAgentRow(rows[0], tool);
    }
});
