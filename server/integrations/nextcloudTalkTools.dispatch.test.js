// @typecheck
/**
 * executeNextcloudTalkTool dispatches by tool name: an unknown name, the
 * argument checks, a recording refusal, both reaction directions and a
 * mark-read keep their requests and answers.
 *
 * Run: cd server && node --test integrations/nextcloudTalkTools.dispatch.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { json, installFakeNc, resetFakeNc } = require('./nextcloudToolFakes');

test.after(resetFakeNc);
const { executeNextcloudTalkTool } = require('./nextcloudTalkTools');

/** @param {string} tool @param {Record<string, unknown>} args */
const talk = (tool, args) => executeNextcloudTalkTool(tool, args, 'u', {});

test('an unknown name and a missing token', async () => {
    installFakeNc(() => json(200, {}));
    assert.deepEqual(await talk('nextcloud_talk_nope', {}), { error: 'Unknown Nextcloud Talk tool: nextcloud_talk_nope' });
    assert.deepEqual(await talk('nextcloud_talk_get_room', {}), { error: 'token is required' });
    assert.deepEqual(await talk('nextcloud_talk_share_file', { token: 't' }), { error: 'path is required' });
});

test('start_recording answers a 403 as not_moderator; the reactions go POST and DELETE; mark_read posts its body', async () => {
    const calls = installFakeNc(({ url }) => (url.includes('/recording/') ? json(403, {}) : json(200, {})));
    assert.equal((await talk('nextcloud_talk_start_recording', { token: 't' })).error, 'not_moderator');
    await talk('nextcloud_talk_add_reaction', { token: 't', messageId: 1, reaction: '+' });
    await talk('nextcloud_talk_remove_reaction', { token: 't', messageId: 1, reaction: '+' });
    assert.deepEqual(await talk('nextcloud_talk_mark_read', { token: 't', lastReadMessage: 5 }), { success: true });
    assert.deepEqual(calls.map((c) => [c.method, c.url.split('/spreed/api/')[1].split('?')[0], c.body]), [
        ['POST', 'v1/recording/t', { status: 2 }],
        ['POST', 'v1/reaction/t/1', { reaction: '+' }],
        ['DELETE', 'v1/reaction/t/1', { reaction: '+' }],
        ['POST', 'v1/chat/t/read', { lastReadMessage: 5 }],
    ]);
});
