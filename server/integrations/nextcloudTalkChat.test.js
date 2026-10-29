'use strict';

/**
 * The Talk chat tools (nextcloudTalkChat.js) against a fake Nextcloud: the
 * request each one sends, and how the answers map to tool results.
 *
 * Run: cd server && node --test integrations/nextcloudTalkChat.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    listMessages, searchMessages, sendMessage, deleteMessage, reactToMessage,
    createPoll, getPoll, votePoll, closePoll,
} = require('./nextcloudTalkChat');

const BASE = 'https://cloud.example.test';

/** A fake auth whose fetch records each call and answers with `reply`. */
function fakeCtx(reply = { status: 200, body: { ocs: { data: [] } } }) {
    const calls = [];
    const ctx = {
        baseUrl: BASE,
        authError: 'Nextcloud is not connected.',
        fetch: async (url, options = {}) => {
            calls.push({ url, method: options.method || 'GET', body: options.body });
            const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
            return {
                status: reply.status,
                ok: reply.status >= 200 && reply.status < 300,
                text: async () => text,
                json: async () => JSON.parse(text),
            };
        },
    };
    return { ctx, calls };
}

test('listMessages drops reaction notices and maps the rest', async () => {
    const { ctx, calls } = fakeCtx({ status: 200, body: { ocs: { data: [
        { id: 1, message: 'hello', actorDisplayName: 'A' },
        { id: 2, message: '', systemMessage: 'reaction' },
    ] } } });
    const out = await listMessages({ token: 'room1', limit: 500 }, ctx);
    assert.equal(out.count, 1);
    assert.match(calls[0].url, /\/api\/v1\/chat\/room1\?lookIntoFuture=0&limit=200&format=json$/);
    assert.deepEqual(await listMessages({}, ctx), { error: 'token is required' });
});

test('listMessages: 304 is an empty page, 401 the auth error', async () => {
    assert.deepEqual(await listMessages({ token: 'r' }, fakeCtx({ status: 304, body: '' }).ctx), { token: 'r', count: 0, messages: [] });
    assert.deepEqual(await listMessages({ token: 'r' }, fakeCtx({ status: 401, body: '' }).ctx), { error: 'Nextcloud is not connected.' });
});

test('searchMessages places each hit in its conversation', async () => {
    const { ctx } = fakeCtx({ status: 200, body: { ocs: { data: { entries: [
        { title: 'a', attributes: { conversation: 'tok1' } },
        { title: 'b', resourceUrl: '/call/tok2#message_9' },
    ] } } } });
    const out = await searchMessages({ query: ' invoice ' }, ctx);
    assert.equal(out.query, 'invoice');
    assert.deepEqual(out.messages.map((m) => m.token), ['tok1', 'tok2']);
    assert.deepEqual(await searchMessages({ query: '  ' }, ctx), { error: 'query is required' });
});

test('sendMessage and deleteMessage send the right request', async () => {
    const sent = fakeCtx({ status: 201, body: { ocs: { data: null } } });
    assert.deepEqual(await sendMessage({ token: 'r', message: 'hi', silent: 1 }, sent.ctx), { success: true });
    assert.equal(sent.calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(sent.calls[0].body), { message: 'hi', replyTo: 0, silent: true });

    const del = fakeCtx({ status: 405, body: '' });
    assert.match((await deleteMessage({ token: 'r', messageId: 5 }, del.ctx)).error, /cannot be deleted/);
    assert.equal(del.calls[0].method, 'DELETE');
});

test('reactToMessage picks the method from the tool and words a 404 for it', async () => {
    const add = fakeCtx({ status: 404, body: '' });
    assert.match((await reactToMessage('nextcloud_talk_add_reaction', { token: 'r', messageId: 3, reaction: '👍' }, add.ctx)).error, /cannot be reacted to/);
    assert.equal(add.calls[0].method, 'POST');
    const remove = fakeCtx({ status: 404, body: '' });
    assert.match((await reactToMessage('nextcloud_talk_remove_reaction', { token: 'r', messageId: 3, reaction: '👍' }, remove.ctx)).error, /^Nothing to remove/);
    assert.equal(remove.calls[0].method, 'DELETE');
});

test('createPoll and votePoll refuse bad input before any request', async () => {
    const { ctx, calls } = fakeCtx();
    assert.deepEqual(await createPoll({ token: 'r', question: 'Q', options: ['a', ' '] }, ctx), { error: 'options must not contain empty choices' });
    assert.deepEqual(await createPoll({ token: 'r', question: 'Q', options: ['a'] }, ctx), { error: 'options must contain at least two choices' });
    assert.deepEqual(await votePoll({ token: 'r', pollId: 1, optionIds: [0, -1] }, ctx), { error: 'optionIds must be 0-based option indexes (non-negative integers)' });
    assert.deepEqual(await votePoll({ token: 'r', pollId: 1, optionIds: [] }, ctx), { error: 'optionIds must contain at least one 0-based option index' });
    assert.equal(calls.length, 0);
});

test('getPoll normalises the votes and status; closePoll deletes', async () => {
    const got = fakeCtx({ status: 200, body: { ocs: { data: { id: 7, question: 'Q', options: ['a', 'b'], votes: { 'option-1': 2 }, numVoters: 2, status: 1 } } } });
    const poll = await getPoll({ token: 'r', pollId: 7 }, got.ctx);
    assert.equal(poll.status, 'closed');
    assert.equal(poll.numVoters, 2);

    const closed = fakeCtx({ status: 200, body: '' });
    assert.deepEqual(await closePoll({ token: 'r', pollId: 7 }, closed.ctx), { success: true, pollId: 7, status: 'closed' });
    assert.equal(closed.calls[0].method, 'DELETE');
});
