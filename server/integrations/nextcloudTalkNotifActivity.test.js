'use strict';
/**
 * Nextcloud Talk / Notifications / Activity tools against a fake Nextcloud:
 * poll errors, reaction system messages, filters (issue 190).
 * Run: cd server && node --test integrations/nextcloudTalkNotifActivity.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { executeNextcloudTalkTool } = require('./nextcloudTalkTools');
const { executeNextcloudNotificationsTool } = require('./nextcloudNotificationsTools');
const { executeNextcloudActivityTool } = require('./nextcloudActivityTools');

const { json, run } = require('./nextcloudToolTestHarness');

// ── Talk ────────────────────────────────────────────────────────────────
test('list_messages drops reaction system messages', async () => {
    const data = [
        { id: 1, message: 'hi' },
        { id: 2, systemMessage: 'reaction' },
        { id: 3, systemMessage: 'reaction_revoked' },
        { id: 4, systemMessage: 'poll_voted' },
        { id: 5, systemMessage: 'reaction_deleted' },
    ];
    const { out } = await run(executeNextcloudTalkTool, 'nextcloud_talk_list_messages', { token: 'tok' },
        async () => json(200, { ocs: { data } }));
    assert.deepStrictEqual(out.messages.map(m => m.id), [1, 4]);
});

test('polls: Talk reasons survive, bad option ids and empty options are refused, votes use bare indexes', async () => {
    const refuse = (code) => async () => json(400, { ocs: { meta: { status: 'failure' }, data: { error: code } } });
    const vote = await run(executeNextcloudTalkTool, 'nextcloud_talk_vote_poll', { token: 't', pollId: 1, optionIds: [9] }, refuse('options'));
    assert.match(vote.out.error, /not a valid option/);
    const close = await run(executeNextcloudTalkTool, 'nextcloud_talk_close_poll', { token: 't', pollId: 1 }, refuse('poll'));
    assert.match(close.out.error, /already closed/);
    const bad = await run(executeNextcloudTalkTool, 'nextcloud_talk_vote_poll', { token: 't', pollId: 1, optionIds: [0, 'x'] }, refuse('x'));
    assert.match(bad.out.error, /0-based/);
    assert.strictEqual(bad.calls.length, 0);
    const empty = await run(executeNextcloudTalkTool, 'nextcloud_talk_create_poll', { token: 't', question: 'q', options: ['a', '', 'b'] }, refuse('x'));
    assert.match(empty.out.error, /empty/);
    const get = await run(executeNextcloudTalkTool, 'nextcloud_talk_get_poll', { token: 't', pollId: 1 }, async () => json(200, { ocs: { data: { id: 1, votes: { 'option-0': 2, 'option-1': 1 } } } }));
    assert.deepStrictEqual(get.out.votes, { 0: 2, 1: 1 });
});

test('reactions and delete have friendly 404/400/405 text', async () => {
    const r = (tool, s) => run(executeNextcloudTalkTool, tool, { token: 't', messageId: 1, reaction: 'x' }, async () => json(s, {}));
    assert.match((await r('nextcloud_talk_remove_reaction', 404)).out.error, /Nothing to remove/);
    assert.match((await r('nextcloud_talk_add_reaction', 400)).out.error, /single emoji/);
    const d = await run(executeNextcloudTalkTool, 'nextcloud_talk_delete_message', { token: 't', messageId: 1 }, async () => json(405, {}));
    assert.match(d.out.error, /already be deleted/);
});

// ── Notifications ───────────────────────────────────────────────────────
test('notifications_dismiss on an unknown id is an error, and limit 0 is not "everything"', async () => {
    const miss = await run(executeNextcloudNotificationsTool, 'nextcloud_notifications_dismiss', { id: 99 }, async (url, init) => (init.method === 'DELETE' ? json(200, {}) : json(404, {})));
    assert.match(miss.out.error, /not found/i);
    assert.ok(!miss.calls.some(c => c.method === 'DELETE'));
    const ok = await run(executeNextcloudNotificationsTool, 'nextcloud_notifications_dismiss', { id: 5 }, async () => json(200, {}));
    assert.strictEqual(ok.out.success, true);
    const items = Array.from({ length: 80 }, (_, i) => ({ notification_id: i }));
    const l0 = await run(executeNextcloudNotificationsTool, 'nextcloud_notifications_list', { limit: 0 }, async () => json(200, { ocs: { data: items } }));
    assert.strictEqual(l0.out.count, 1);
    const ld = await run(executeNextcloudNotificationsTool, 'nextcloud_notifications_list', {}, async () => json(200, { ocs: { data: items } }));
    assert.strictEqual(ld.out.count, 50);
});

// ── Activity ────────────────────────────────────────────────────────────
test('activity: a bogus filter is refused before any request; type and "by" are applied', async () => {
    const bogus = await run(executeNextcloudActivityTool, 'nextcloud_activity_list', { filter: 'bogus' }, async () => json(404, {}));
    assert.match(bogus.out.error, /filter must be one of/);
    assert.strictEqual(bogus.calls.length, 0);
    const data = [
        { activity_id: 1, user: 'alice', type: 'file_changed', object_type: 'files' },
        { activity_id: 2, user: 'bob', type: 'shared', object_type: 'files' },
        { activity_id: 3, user: 'bob', type: 'comments', object_type: 'files' },
    ];
    const by = await run(executeNextcloudActivityTool, 'nextcloud_activity_list', { filter: 'by' }, async () => json(200, { ocs: { data } }));
    assert.deepStrictEqual(by.out.activities.map(a => a.id), [2, 3]);
    assert.ok(!by.calls[0].url.includes('type='));
    const typed = await run(executeNextcloudActivityTool, 'nextcloud_activity_list', { type: 'shared' }, async () => json(200, { ocs: { data } }));
    assert.deepStrictEqual(typed.out.activities.map(a => a.id), [2]);
});
