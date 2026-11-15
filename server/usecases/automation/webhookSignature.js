// @typecheck strict
/**
 * The signature check of the inbound webhook trigger (events.js).
 *
 * The sender signs `nonce "\n" body` with the webhook secret. Two things about
 * what "body" means:
 *   - It is the request's own bytes when the parser kept them (req.rawBody),
 *     so a sender signs what it sent, not what JSON.stringify would rebuild.
 *     A sender from before that is still accepted: the rebuilt form is tried
 *     second.
 *   - With an X-BeeFlow-Timestamp header (unix seconds) the signature covers
 *     `nonce "\n" timestamp "\n" body` and the timestamp has to be within
 *     five minutes of now, so a captured request stops working after that
 *     window on its own, before the nonce store is asked.
 * Every compare is constant-time.
 *
 * A webhook in 'header_token' mode (for a caller that cannot sign) is
 * checked by checkHeaderToken instead: the caller sends a fixed token in
 * `Authorization: Bearer <token>` or `X-BeeFlow-Token`, and its sha256 is
 * compared with the one stored for the webhook. Never from the query string.
 * Weaker than signing: whoever sees the token can send deliveries, and a
 * delivery without a nonce can be sent again.
 */

'use strict';

const crypto = require('crypto');

const TIMESTAMP_SKEW_SECONDS = 300;

/**
 * @param {string} secret
 * @param {string} message
 */
function hmacHeader(secret, message) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * @param {string} given
 * @param {string} expected
 */
function sameSignature(given, expected) {
    // Lengths are compared in BYTES: a header value arrives latin1-decoded, so
    // a non-ASCII character keeps the string length and changes the byte
    // length, and timingSafeEqual throws on buffers of unequal length.
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A secret that is not a non-empty string verifies nothing.
 * @param {{ secret: string | null, sigHeader: string, nonce: string, timestamp?: string | null,
 *   rawBody?: string | null, body?: unknown, now?: number }} input
 * @returns {{ ok: boolean, reason?: 'missing' | 'stale_timestamp' | 'bad_signature' }}
 */
function checkWebhookSignature({ secret, sigHeader, nonce, timestamp = null, rawBody = null, body = undefined, now = Date.now() }) {
    if (!sigHeader || !sigHeader.startsWith('sha256=') || !nonce) return { ok: false, reason: 'missing' };
    if (typeof secret !== 'string' || !secret) return { ok: false, reason: 'bad_signature' };
    const stamp = timestamp || null;
    if (stamp !== null && !timestampIsFresh(stamp, now)) return { ok: false, reason: 'stale_timestamp' };
    const prefix = stamp === null ? `${nonce}\n` : `${nonce}\n${stamp}\n`;
    const matched = bodyForms(rawBody, body).some((b) => sameSignature(sigHeader, hmacHeader(secret, prefix + b)));
    return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * The body texts a signature may cover: the request's own bytes first, the
 * rebuilt JSON form second (once, when the two differ).
 * @param {string | null | undefined} rawBody
 * @param {unknown} body
 */
function bodyForms(rawBody, body) {
    const rebuilt = JSON.stringify(body === undefined || body === null ? {} : body);
    return typeof rawBody === 'string' && rawBody !== rebuilt ? [rawBody, rebuilt] : [rebuilt];
}

/**
 * @param {string} timestamp  unix seconds as sent
 * @param {number} now        milliseconds
 */
function timestampIsFresh(timestamp, now) {
    if (!isDigits(timestamp, 12)) return false;
    return Math.abs(Math.floor(now / 1000) - Number(timestamp)) <= TIMESTAMP_SKEW_SECONDS;
}

/**
 * One to `max` ASCII digits and nothing else (a plain loop: the input is a request header).
 * @param {string} s
 * @param {number} max
 */
function isDigits(s, max) {
    if (s.length < 1 || s.length > max) return false;
    for (const c of s) if (c < '0' || c > '9') return false;
    return true;
}

/**
 * The sha256 (hex) a header token is stored and compared as.
 * @param {string} token
 */
function hashWebhookToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Does the token a caller sent match the stored hash? Constant-time; an empty
 * token or a stored hash that is not a non-empty string verifies nothing.
 * @param {{ tokenHash: string | null, token: string }} input
 * @returns {{ ok: boolean, reason?: 'missing' | 'bad_signature' }}
 */
function checkHeaderToken({ tokenHash, token }) {
    if (!token) return { ok: false, reason: 'missing' };
    if (typeof tokenHash !== 'string' || !tokenHash) return { ok: false, reason: 'bad_signature' };
    return sameSignature(hashWebhookToken(token), tokenHash) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * The token a delivery carries in its headers: `Authorization: Bearer <token>`
 * first, else `X-BeeFlow-Token`. Plain string operations (request text).
 * @param {string | null | undefined} authorization
 * @param {string | null | undefined} tokenHeader
 */
function tokenFromHeaders(authorization, tokenHeader) {
    const auth = typeof authorization === 'string' ? authorization.trim() : '';
    if (auth.length > 7 && auth.slice(0, 7).toLowerCase() === 'bearer ') {
        const token = auth.slice(7).trim();
        if (token) return token;
    }
    return typeof tokenHeader === 'string' ? tokenHeader.trim() : '';
}

module.exports = { checkWebhookSignature, hmacHeader, sameSignature, hashWebhookToken, checkHeaderToken, tokenFromHeaders, TIMESTAMP_SKEW_SECONDS };
