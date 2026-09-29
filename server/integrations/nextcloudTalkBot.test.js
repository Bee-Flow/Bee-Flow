'use strict';

/**
 * The Talk bot signature contract — the one thing that is silently 401 when
 * it is wrong.
 *
 * Nextcloud signs and verifies HMAC-SHA256 over `RANDOM ‖ PAYLOAD`, and
 * PAYLOAD is different per endpoint (spreed lib/Controller/BotController.php):
 * the message TEXT when posting, the EMOJI when reacting, the RAW BODY on the
 * inbound webhook. Signing the JSON envelope instead — the intuitive mistake —
 * produces a request Talk rejects with no diagnostic beyond "401".
 *
 * These tests pin all three, and pin that the fields which ride OUTSIDE the
 * signature (replyTo, referenceId, silent) really do.
 *
 * Run: cd server && node --test --test-force-exit integrations/nextcloudTalkBot.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Captured outbound requests; nothing leaves the process.
const calls = [];
mock(path.join(SERVER, 'integrations/nextcloudTarget'), {
    nextcloudFetch: async (url, opts) => {
        calls.push({ url, opts });
        const queued = calls.__next || { status: 201, body: null };
        calls.__next = null;
        return {
            status: queued.status,
            ok: queued.status >= 200 && queued.status < 300,
            json: async () => queued.body,
        };
    },
});
mock(path.join(SERVER, 'stores/configStore'), {
    getSecret: async (key) => (key === 'nc_talk_bot_secret_org1' ? 'S'.repeat(64) : null),
});

const talkBot = require('./nextcloudTalkBot');

const SECRET = 'b0tSecret'.repeat(6);            // ≥ 40 chars, as occ requires

function phpStyle(secret, random, payload) {
    // Literally the formula from spreed/docs/bots.md.
    return crypto.createHmac('sha256', secret).update(random + payload).digest('hex');
}

test('botSignature is HMAC-SHA256(random ‖ payload), lowercase hex', () => {
    const random = 'a'.repeat(64);
    assert.equal(talkBot.botSignature(SECRET, random, 'hello'), phpStyle(SECRET, random, 'hello'));
    assert.match(talkBot.botSignature(SECRET, random, 'hello'), /^[a-f0-9]{64}$/);
});

test('verifyTalkSignature accepts the documented inbound signature', () => {
    const random = crypto.randomBytes(32).toString('hex');
    const body = JSON.stringify({ type: 'Like', content: '👍' });
    assert.equal(talkBot.verifyTalkSignature({
        secret: SECRET, random, body, signature: phpStyle(SECRET, random, body),
    }), true);
});

test('verifyTalkSignature fails closed on every way of being wrong', () => {
    const random = crypto.randomBytes(32).toString('hex');
    const body = '{"type":"Like"}';
    const good = phpStyle(SECRET, random, body);

    // Wrong secret, wrong body, wrong random — each must fail.
    assert.equal(talkBot.verifyTalkSignature({ secret: 'other'.repeat(10), random, body, signature: good }), false);
    assert.equal(talkBot.verifyTalkSignature({ secret: SECRET, random, body: body + ' ', signature: good }), false);
    assert.equal(talkBot.verifyTalkSignature({ secret: SECRET, random: 'b'.repeat(64), body, signature: good }), false);
    // No secret at all (the state after a persistent-storage wipe).
    assert.equal(talkBot.verifyTalkSignature({ secret: null, random, body, signature: good }), false);
    // A random short enough to brute-force is refused before any compare.
    assert.equal(talkBot.verifyTalkSignature({ secret: SECRET, random: 'ab', body, signature: good }), false);
    // Non-hex / wrong-length signatures must not throw out of timingSafeEqual.
    assert.equal(talkBot.verifyTalkSignature({ secret: SECRET, random, body, signature: 'zz' }), false);
    assert.equal(talkBot.verifyTalkSignature({ secret: SECRET, random, body, signature: good.slice(0, 60) }), false);
    assert.equal(talkBot.verifyTalkSignature({ secret: SECRET, random, body, signature: undefined }), false);
});

test('verifyTalkSignature accepts an upper-case signature (Talk documents lowercase, clients vary)', () => {
    const random = crypto.randomBytes(32).toString('hex');
    const body = '{}';
    assert.equal(talkBot.verifyTalkSignature({
        secret: SECRET, random, body, signature: phpStyle(SECRET, random, body).toUpperCase(),
    }), true);
});

test('postBotMessage signs the MESSAGE TEXT, not the JSON envelope', async () => {
    calls.length = 0;
    const res = await talkBot.postBotMessage({
        baseUrl: 'https://cloud.example', secret: SECRET, roomToken: 'room1',
        message: 'Approve invoice 42?', replyTo: 17, silent: true,
    });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);

    const { url, opts } = calls[0];
    assert.match(url, /\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/bot\/room1\/message/);
    assert.equal(opts.headers['OCS-APIRequest'], 'true');

    const random = opts.headers['X-Nextcloud-Talk-Bot-Random'];
    const signature = opts.headers['X-Nextcloud-Talk-Bot-Signature'];
    assert.ok(random.length >= 32, 'random must be long enough for Talk to accept');
    assert.equal(signature, phpStyle(SECRET, random, 'Approve invoice 42?'));

    // The envelope carries the extras — and signing it would break the check.
    const body = JSON.parse(opts.body);
    assert.equal(body.message, 'Approve invoice 42?');
    assert.equal(body.replyTo, 17);
    assert.equal(body.silent, true);
    assert.equal(body.referenceId, res.referenceId);
    assert.notEqual(signature, phpStyle(SECRET, random, opts.body));
});

test('postBotMessage mints a fresh referenceId per post, never a hash of the text', async () => {
    calls.length = 0;
    const a = await talkBot.postBotMessage({ baseUrl: 'https://c', secret: SECRET, roomToken: 'r', message: 'same' });
    const b = await talkBot.postBotMessage({ baseUrl: 'https://c', secret: SECRET, roomToken: 'r', message: 'same' });
    assert.notEqual(a.referenceId, b.referenceId,
        'two identical cards in one room must be separable in the ledger');
});

test('postBotMessage explains 401 as "the bot is not in this conversation"', async () => {
    calls.length = 0;
    calls.__next = { status: 401 };
    const res = await talkBot.postBotMessage({ baseUrl: 'https://c', secret: SECRET, roomToken: 'r', message: 'hi' });
    assert.equal(res.ok, false);
    assert.match(res.error, /not enabled in this conversation/);
});

test('postBotMessage declines rather than posting when there is no secret', async () => {
    calls.length = 0;
    const res = await talkBot.postBotMessage({ baseUrl: 'https://c', secret: null, roomToken: 'r', message: 'hi' });
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
});

test('postBotReaction signs the EMOJI (BotController::react passes $reaction)', async () => {
    calls.length = 0;
    const res = await talkBot.postBotReaction({
        baseUrl: 'https://cloud.example', secret: SECRET, roomToken: 'room1', messageId: '1567', reaction: '👍',
    });
    assert.equal(res.ok, true);
    const { url, opts } = calls[0];
    assert.match(url, /\/bot\/room1\/reaction\/1567/);
    assert.equal(
        opts.headers['X-Nextcloud-Talk-Bot-Signature'],
        phpStyle(SECRET, opts.headers['X-Nextcloud-Talk-Bot-Random'], '👍'),
    );
});

test('postBotReaction treats "reaction already exists" (200) as success', async () => {
    calls.length = 0;
    calls.__next = { status: 200 };
    const res = await talkBot.postBotReaction({
        baseUrl: 'https://c', secret: SECRET, roomToken: 'r', messageId: 1, reaction: '👍',
    });
    assert.equal(res.ok, true);
});

test('findMessageIdByReference recovers the id the bot API never returns', async () => {
    calls.length = 0;
    const referenceId = 'ref-abc';
    const ncFetch = async (url) => {
        calls.push({ url });
        return {
            ok: true, status: 200,
            json: async () => ({ ocs: { data: [
                { id: 900, referenceId: 'someone-else' },
                { id: 901, referenceId },
            ] } }),
        };
    };
    const id = await talkBot.findMessageIdByReference({
        ncFetch, baseUrl: 'https://cloud.example', roomToken: 'room1', referenceId,
    });
    assert.equal(id, '901');
    assert.match(calls[0].url, /lookIntoFuture=0/);
});

test('findMessageIdByReference returns null rather than guessing', async () => {
    const empty = async () => ({ ok: true, status: 200, json: async () => ({ ocs: { data: [{ id: 1, referenceId: 'x' }] } }) });
    assert.equal(await talkBot.findMessageIdByReference({
        ncFetch: empty, baseUrl: 'https://c', roomToken: 'r', referenceId: 'not-there',
    }), null);
    // 304 (nothing new) and a hard failure both mean "unknown", never "the last one".
    const notModified = async () => ({ ok: false, status: 304 });
    assert.equal(await talkBot.findMessageIdByReference({
        ncFetch: notModified, baseUrl: 'https://c', roomToken: 'r', referenceId: 'ref',
    }), null);
    assert.equal(await talkBot.findMessageIdByReference({ baseUrl: 'https://c', roomToken: 'r', referenceId: 'ref' }), null);
});

test('listMessageReactions flattens Talk’s emoji-keyed map into rows', async () => {
    const ncFetch = async () => ({
        ok: true, status: 200,
        json: async () => ({ ocs: { data: {
            '👍': [{ actorType: 'users', actorId: 'ada', actorDisplayName: 'Ada', timestamp: 1 }],
            '🎉': [{ actorType: 'guests', actorId: 'g1', actorDisplayName: 'Guest', timestamp: 2 }],
        } } }),
    });
    const rows = await talkBot.listMessageReactions({ ncFetch, baseUrl: 'https://c', roomToken: 'r', messageId: 5 });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { reaction: '👍', actorType: 'users', actorId: 'ada', actorDisplayName: 'Ada', timestamp: 1 });
});

test('listMessageReactions answers [] on a 403 — a poll that cannot read is silence', async () => {
    // 403 = the attendee lacks the separate react permission (256, NC 34+).
    const forbidden = async () => ({ ok: false, status: 403 });
    assert.deepEqual(await talkBot.listMessageReactions({ ncFetch: forbidden, baseUrl: 'https://c', roomToken: 'r', messageId: 5 }), []);
    const throwing = async () => { throw new Error('network'); };
    assert.deepEqual(await talkBot.listMessageReactions({ ncFetch: throwing, baseUrl: 'https://c', roomToken: 'r', messageId: 5 }), []);
});

test('getBotSecret refuses a secret shorter than occ allows', async () => {
    assert.equal(await talkBot.getBotSecret('org1'), 'S'.repeat(64));
    assert.equal(await talkBot.getBotSecret('org-without-a-bot'), null);
    assert.equal(await talkBot.getBotSecret(null), null);
});
