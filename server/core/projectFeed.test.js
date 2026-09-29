/**
 * The one way to write into a project's live feed.
 *
 * This helper was hand-copied into three producers (the projects routes, agent
 * chat streaming and direct chat) and verified in none of them — the tests that
 * touched those paths mocked it only so it would not explode. It now has one
 * implementation, so these are the rules that implementation owes everyone:
 *
 *   1. PERSIST FIRST, THEN PUBLISH. The row assigns the gapless per-project
 *      seq, and subscribers read forward from a cursor. Publishing first lets a
 *      subscriber wake, read, and find nothing.
 *   2. THE NOTIFICATION CARRIES THE STORED FIELDS. seq is what a client
 *      advances its cursor with.
 *   3. BEST-EFFORT, ALWAYS. A live-feed update must never fail the action that
 *      produced it — a chat turn that answered correctly has not failed
 *      because the sidebar did not blink.
 *
 * Run: cd server && node --test core/projectFeed.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const storePath = require.resolve('../stores/projectStore');
const busPath = require.resolve('./projectEventBus');

const calls = [];
let appendResult = { seq: 7, id: 'evt1' };
let appendError = null;
let publishError = null;

require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: {
        appendProjectEvent: async (projectId, event) => {
            calls.push({ fn: 'append', projectId, event });
            if (appendError) throw appendError;
            return appendResult;
        },
    },
};
require.cache[busPath] = {
    id: busPath, filename: busPath, loaded: true,
    exports: {
        publishProjectEvent: async (projectId, payload) => {
            calls.push({ fn: 'publish', projectId, payload });
            if (publishError) throw publishError;
        },
    },
};

const { emitProjectEvent } = require('./projectFeed');

function reset() {
    calls.length = 0;
    appendResult = { seq: 7, id: 'evt1' };
    appendError = null;
    publishError = null;
}

test('it persists before it publishes', async () => {
    reset();
    await emitProjectEvent('p1', { kind: 'member_added' });
    assert.deepStrictEqual(calls.map(c => c.fn), ['append', 'publish'],
        'the row assigns the seq, so it must exist before anyone is told to read');
});

test('the notification carries the stored fields', async () => {
    reset();
    await emitProjectEvent('p1', { kind: 'member_added', actorId: 'alice' });
    const published = calls.find(c => c.fn === 'publish');
    assert.strictEqual(published.projectId, 'p1');
    assert.strictEqual(published.payload.kind, 'member_added');
    assert.strictEqual(published.payload.actorId, 'alice');
    assert.strictEqual(published.payload.seq, 7, 'clients advance their cursor with this');
    assert.strictEqual(published.payload.id, 'evt1');
});

test('no project means no work at all', async () => {
    reset();
    await emitProjectEvent(null, { kind: 'x' });
    await emitProjectEvent(undefined, { kind: 'x' });
    await emitProjectEvent('', { kind: 'x' });
    assert.strictEqual(calls.length, 0, 'a standalone thread never touches the feed');
});

test('nothing stored means nothing published', async () => {
    reset();
    appendResult = null;
    await emitProjectEvent('p1', { kind: 'x' });
    assert.deepStrictEqual(calls.map(c => c.fn), ['append'],
        'without a seq there is nothing for a subscriber to read forward to');
});

test('a failing store never fails the caller', async () => {
    reset();
    appendError = new Error('db down');
    await assert.doesNotReject(() => emitProjectEvent('p1', { kind: 'x' }));
});

test('a failing publish never fails the caller', async () => {
    reset();
    publishError = new Error('redis down');
    // The row is already durable, so this costs latency, not data: the
    // subscriber picks it up on its next poll.
    await assert.doesNotReject(() => emitProjectEvent('p1', { kind: 'x' }));
    assert.ok(calls.some(c => c.fn === 'append'), 'and the row was still written');
});

test('the label names the producer in the warning, and nothing else', async () => {
    reset();
    appendError = new Error('db down');
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        await emitProjectEvent('p1', { kind: 'x' }, { label: 'DirectChat' });
        await emitProjectEvent('p1', { kind: 'x' });
    } finally {
        console.warn = original;
    }
    assert.ok(warnings[0].includes('[DirectChat]'), 'the producer that stumbled is named');
    assert.ok(warnings[1].includes('[Projects]'), 'and defaults when it is not');
});
