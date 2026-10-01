/**
 * The pending-decision queue behind the review popup (decisionQueue.js).
 *
 * The bug this pins: the queue held a question for 60 seconds flat. Reviewing
 * a finding list and marking spans takes longer than that, so the entry was
 * deleted mid-edit and "Redact and send" came back as "Decision not found,
 * expired, or not owned by this user." — while the stream failed closed.
 *
 * Two behaviours now carry that weight:
 *
 *   - `touch` refreshes the TTL, so a review that is still open (the UI
 *     heartbeats) never expires from under the person;
 *   - silence still expires — fail-closed — so a question nobody answers
 *     becomes a block rather than hanging the stream forever.
 *
 * Run: node --test server/core/dlp/decisionQueue.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

const queue = require('./decisionQueue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('touch keeps the decision alive past its original TTL, and it still resolves', async () => {
    const { decisionId, promise } = queue.register({ conversationId: 'c1', userId: 'u1', timeoutMs: 60 });
    // Heartbeat twice inside the TTL — 100ms of review against a 60ms TTL.
    for (let i = 0; i < 4; i++) {
        await sleep(25);
        assert.strictEqual(queue.touch(decisionId, 'u1'), true, 'a pending decision answers its heartbeat');
    }
    assert.strictEqual(queue.resolve(decisionId, { choice: 'redact' }, 'u1'), true, 'redact-and-send after the delay still lands');
    assert.deepStrictEqual(await promise, { choice: 'redact' });
});

test('silence still expires: an untouched decision is gone after its TTL', async () => {
    const { decisionId, promise } = queue.register({ conversationId: 'c1', userId: 'u1', timeoutMs: 40 });
    const rejection = assert.rejects(promise, (err) => err.code === 'DLP_TIMEOUT');
    await sleep(80);
    await rejection;
    assert.strictEqual(queue.resolve(decisionId, { choice: 'redact' }, 'u1'), false, 'expired → the 404 the client shows');
    assert.strictEqual(queue.touch(decisionId, 'u1'), false, 'no heartbeating a dead decision back to life');
});

test('touch honours ownership, like resolve does', async () => {
    const { decisionId, promise } = queue.register({ conversationId: 'c1', userId: 'u1', timeoutMs: 1000 });
    promise.catch(() => {});
    assert.strictEqual(queue.touch(decisionId, 'someone-else'), false);
    assert.strictEqual(queue.touch(decisionId, 'u1'), true);
    queue.reject(decisionId, 'cleanup');
});

test('the default TTL is minutes, not the 60 seconds that expired mid-review', () => {
    assert.ok(
        queue.DEFAULT_TIMEOUT_MS >= 10 * 60 * 1000,
        `default TTL ${queue.DEFAULT_TIMEOUT_MS}ms must outlast a careful manual review`,
    );
});
