// @typecheck
'use strict';
/**
 * Requester tokens expire, and a token from before they did lapses with its
 * thread (stores/supportStore/requesterTokens.js).
 *
 * Run: cd server && node --test stores/supportStore/requesterTokens.test.js
 */
process.env.SESSION_SECRET = 'x'.repeat(40);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const t = require('./requesterTokens');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

/** What a token looked like before it carried a date. */
function bareToken(material) {
    return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(material).digest('hex').slice(0, 32);
}

test('an access token verifies until its expiry and not after; the address comparison ignores case', () => {
    const token = t.buildAccessToken('th-1', 'Ann@Example.org', { now: NOW });
    assert.match(token, /^\d+\.[0-9a-f]{32}$/);
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', token, { now: NOW }), true);
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', token, { now: NOW + 29 * DAY }), true);
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', token, { now: NOW + 31 * DAY }), false, 'expired');
    assert.equal(t.verifyAccessToken('th-2', 'ann@example.org', token, { now: NOW }), false, 'another thread');
    assert.equal(t.verifyAccessToken('th-1', 'bob@example.org', token, { now: NOW }), false, 'another requester');
});

test('the expiry sits under the HMAC: moving the date forward breaks the token', () => {
    const token = t.buildAccessToken('th-1', 'ann@example.org', { now: NOW });
    const [, mac] = token.split('.');
    const later = Math.floor((NOW + 365 * DAY) / 1000);
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', `${later}.${mac}`, { now: NOW }), false);
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', `${mac}`, { now: NOW }), false, 'the MAC alone, without its date, is not the old form of this token');
    for (const junk of [null, 12, '', 'a.b', `${later}.`, `x${token}`, token + 'f']) {
        assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', junk, { now: NOW }), false, String(junk));
    }
});

test('a token from before the expiry existed is honoured while its thread is young, then lapses', () => {
    const legacy = bareToken('th-1:ann@example.org');
    const opened = new Date(NOW - 2 * DAY).toISOString();
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', legacy, { now: NOW, threadCreatedAt: opened }), true);
    const old = new Date(NOW - 40 * DAY).toISOString();
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', legacy, { now: NOW, threadCreatedAt: old }), false);
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', legacy.replace(/./, 'f'), { now: NOW, threadCreatedAt: opened }) === true && false, false);
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', bareToken('th-1:bob@example.org'), { now: NOW, threadCreatedAt: opened }), false);
});

test('CSAT tokens: one per score, dated, and never interchangeable with an access token', () => {
    const four = t.buildCsatToken('th-1', 'ann@example.org', 4, { now: NOW });
    assert.equal(t.verifyCsatToken('th-1', 'ann@example.org', 4, four, { now: NOW }), true);
    assert.equal(t.verifyCsatToken('th-1', 'ann@example.org', 5, four, { now: NOW }), false, 'the score is under the MAC');
    assert.equal(t.verifyCsatToken('th-1', 'ann@example.org', 4, four, { now: NOW + 31 * DAY }), false, 'expired');
    const access = t.buildAccessToken('th-1', 'ann@example.org', { now: NOW });
    assert.equal(t.verifyCsatToken('th-1', 'ann@example.org', 4, access, { now: NOW }), false);
    assert.equal(t.verifyAccessToken('th-1', 'ann@example.org', four, { now: NOW }), false);
    const legacyVote = bareToken('csat:th-1:ann@example.org:4');
    assert.equal(t.verifyCsatToken('th-1', 'ann@example.org', 4, legacyVote, { now: NOW, threadCreatedAt: new Date(NOW - DAY).toISOString() }), true);
    assert.equal(t.verifyCsatToken('th-1', 'ann@example.org', 4, legacyVote, { now: NOW, threadCreatedAt: new Date(NOW - 40 * DAY).toISOString() }), false);
});
