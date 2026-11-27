const {test} = require('node:test');
const assert = require('node:assert/strict');
const {homeReply, mountHomeIntent} = require('./coworkHomeIntent');

test('Bee navigation accepts only known destinations and never accepts a model-selected operation', () => {
    assert.throws(() => homeReply('{"action":"forceDelete"}', 1), /could not read/);
    assert.throws(() => homeReply('broken', 1), /could not read/);
    const reply = homeReply(JSON.stringify({action: 'task', indices: [-1, 1, 1, '0', 5], role: 'owner', responses: ['Approve', 'Cancel']}), 2);
    assert.deepEqual(reply.indices, [1]);
    assert.deepEqual(reply.responses, []);
    assert.equal(reply.role, undefined);
});

test('only explanatory turns offer distinct bounded text answers', () => {
    const reply = homeReply(JSON.stringify({action: 'answer', responses: [' One ', 'One', 'Two', {action: 'run'}], brief: 'ignore', section: 'invented'}), 0);
    assert.deepEqual(reply.responses, ['One', 'Two']);
    assert.equal(reply.brief, undefined);
    assert.equal(reply.section, undefined);
    assert.deepEqual(homeReply('{"action":"answer","responses":["Yes","Yes"]}', 0).responses, []);
});

test('the home route uses the reader and checks spend before streaming only the visible answer', async t => {
    const router = require('express').Router();
    const calls = [];
    mountHomeIntent(router, {
        org: async (_req, {userId}) => {assert.equal(userId, 'reader'); return 'org';},
        spend: async ({userId}) => {calls.push(['budget', userId]);},
        model: async ({stream, userId, userOrgId, tier}) => {
            calls.push(['model', userId, userOrgId, tier]);
            stream.onText('{"action":"teamwork","answer":"private routing"}');
            stream.onText('{"action":"answer","answer":"Which desk');
            return '{"action":"answer","answer":"Which desk?","responses":["Finance","Sales"]}';
        },
    });
    const api = require('../testUtils/routeHarness').serve('/api/cowork', router, {user:{id:'reader'}});
    t.after(api.close);
    const response = await api.call('POST', '/api/cowork/home/intent', {body:{message:'Help me choose', titles:[]},headers:{Accept:'text/event-stream'}});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(response.text, /event: answer/);
    assert.match(response.text, /Which desk/);
    assert.match(response.text, /event: reply/);
    assert.doesNotMatch(response.text, /private routing/);
    assert.deepEqual(calls, [['budget', 'reader'], ['model', 'reader', 'org', 'thinking']]);
});
