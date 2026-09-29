/**
 * youtrackClient — the parts of the wire format the support hub depends on.
 *
 * The comments endpoint lists oldest first and takes no sort. Reading the
 * newest comment therefore needs two things from this client: the issue's
 * `commentsCount` (the offset), and a `$skip` on the comments request. Without
 * either, `$top=1` is the first comment ever made (BFSF-445).
 *
 * Run: cd server && node --test integrations/youtrackClient.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { installResolveStub } = require('../testUtils/stubRequire');

const restoreStubs = installResolveStub({
    '../stores/configStore': { getSecret: async () => null, getConfig: async () => null },
});
const ytc = require('./youtrackClient');

const CREDS = { baseUrl: 'https://yt.example.com', token: 'test-token' };

const realFetch = global.fetch;
let requests = [];
let reply = [];

beforeEach(() => {
    requests = [];
    reply = [];
    global.fetch = async (url) => {
        requests.push(new URL(String(url)));
        return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
    };
});

after(() => {
    global.fetch = realFetch;
    restoreStubs();
});

test('issue reads ask for commentsCount and hand it back', async () => {
    reply = [{
        idReadable: 'BFSF-1', summary: 'A bug', resolved: null, commentsCount: 3,
        customFields: [{ name: 'State', value: { name: 'Open' } }],
    }];
    const [issue] = await ytc.getIssuesByIds(CREDS, ['BFSF-1']);

    assert.match(requests[0].searchParams.get('fields'), /(^|,)commentsCount(,|$)/);
    assert.strictEqual(issue.commentsCount, 3);
    assert.strictEqual(issue.state, 'Open');
});

test('a single issue read carries the count too', async () => {
    reply = { idReadable: 'BFSF-2', summary: 'Another', commentsCount: 0, customFields: [] };
    const issue = await ytc.getIssue(CREDS, 'BFSF-2');
    assert.match(requests[0].searchParams.get('fields'), /(^|,)commentsCount(,|$)/);
    assert.strictEqual(issue.commentsCount, 0);
});

test('an issue shaped without a count says so instead of claiming zero', () => {
    assert.strictEqual(ytc.shapeIssue({ idReadable: 'BFSF-3' }).commentsCount, null);
});

test('comments are read from an offset', async () => {
    reply = [{ id: 'c3', text: 'newest', created: Date.parse('2026-01-03T10:00:00Z'), author: { login: 'dev' } }];
    const comments = await ytc.getIssueComments(CREDS, 'BFSF-1', { skip: 2, limit: 1 });

    assert.strictEqual(requests[0].pathname, '/api/issues/BFSF-1/comments');
    assert.strictEqual(requests[0].searchParams.get('$skip'), '2');
    assert.strictEqual(requests[0].searchParams.get('$top'), '1');
    assert.deepStrictEqual(comments, [{ id: 'c3', text: 'newest', author: 'dev', created: '2026-01-03T10:00:00.000Z' }]);
});

test('no offset reads from the start, and a bad one is clamped to it', async () => {
    await ytc.getIssueComments(CREDS, 'BFSF-1');
    await ytc.getIssueComments(CREDS, 'BFSF-1', { skip: -4 });
    assert.deepStrictEqual(requests.map(r => r.searchParams.get('$skip')), ['0', '0']);
});
