/**
 * Characterization tests for the shared Gmail parsing helpers (H6 adoption
 * lock). extractTextBody was folded in VERBATIM from the byte-identical copies
 * in routes/integrations/gmail.js and integrations/gmailTools.js — these tests
 * pin its contract (notably: direct-children html BEATS deeper nested plain,
 * which is why extractGmailBodies' deep-walk was NOT a drop-in replacement)
 * plus the header/decode helpers those files adopted.
 *
 * Pure module — zero stubs, zero I/O.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    getGmailHeader,
    decodeBase64Url,
    extractGmailBodies,
    extractTextBody,
} = require('./parse');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

// ── decodeBase64Url ─────────────────────────────────────────────────

test('decodeBase64Url: roundtrip incl. url-safe -/_ chars; empty passthrough', () => {
    const s = 'héllo >>? ÿ~';
    assert.strictEqual(decodeBase64Url(b64(s)), s);
    assert.strictEqual(decodeBase64Url(''), '');
    assert.strictEqual(decodeBase64Url(null), '');
});

// ── getGmailHeader ──────────────────────────────────────────────────

test('getGmailHeader: case-insensitive, tolerant of missing name and null headers', () => {
    const headers = [
        { name: 'From', value: 'a@b.c' },
        { value: 'entry-without-name' },
        { name: 'Subject', value: 'Hi' },
    ];
    assert.strictEqual(getGmailHeader(headers, 'from'), 'a@b.c');
    assert.strictEqual(getGmailHeader(headers, 'SUBJECT'), 'Hi');
    assert.strictEqual(getGmailHeader(headers, 'Missing'), '');
    assert.strictEqual(getGmailHeader(null, 'From'), '');
    assert.strictEqual(getGmailHeader(undefined, 'From'), '');
});

// ── extractTextBody (the folded-in direct-children-first contract) ──

test('extractTextBody: single-part text/plain', () => {
    assert.strictEqual(
        extractTextBody({ mimeType: 'text/plain', body: { data: b64('plain body') } }),
        'plain body',
    );
});

test('extractTextBody: direct text/plain preferred over direct text/html', () => {
    const payload = {
        mimeType: 'multipart/alternative',
        parts: [
            { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } },
            { mimeType: 'text/plain', body: { data: b64('plain body') } },
        ],
    };
    assert.strictEqual(extractTextBody(payload), 'plain body');
});

test('extractTextBody: direct html (tag-stripped) beats DEEPER nested text/plain', () => {
    // This is the contract that made extractGmailBodies (deep-walk, first
    // text/plain anywhere) a non-drop-in: the inline copies stop at direct
    // children before recursing.
    const payload = {
        mimeType: 'multipart/mixed',
        parts: [
            { mimeType: 'text/html', body: { data: b64('<b>bold</b>  html') } },
            {
                mimeType: 'multipart/alternative',
                parts: [{ mimeType: 'text/plain', body: { data: b64('nested plain') } }],
            },
        ],
    };
    assert.strictEqual(extractTextBody(payload), 'bold html');
});

test('extractTextBody: recurses into nested multipart when no direct text parts', () => {
    const payload = {
        mimeType: 'multipart/mixed',
        parts: [
            { mimeType: 'application/pdf', body: { attachmentId: 'x' } },
            {
                mimeType: 'multipart/alternative',
                parts: [{ mimeType: 'text/plain', body: { data: b64('deep plain') } }],
            },
        ],
    };
    assert.strictEqual(extractTextBody(payload), 'deep plain');
});

test('extractTextBody: empty/absent payload → empty string', () => {
    assert.strictEqual(extractTextBody(null), '');
    assert.strictEqual(extractTextBody({}), '');
    assert.strictEqual(extractTextBody({ mimeType: 'multipart/mixed', parts: [] }), '');
});

// ── extractGmailBodies stays untouched (deep-walk, both bodies, raw html) ──

test('extractGmailBodies: deep-walk returns BOTH bodies, html left raw', () => {
    const payload = {
        mimeType: 'multipart/mixed',
        parts: [
            { mimeType: 'text/html', body: { data: b64('<p>raw html</p>') } },
            {
                mimeType: 'multipart/alternative',
                parts: [{ mimeType: 'text/plain', body: { data: b64('nested plain') } }],
            },
        ],
    };
    assert.deepStrictEqual(extractGmailBodies(payload), {
        text: 'nested plain',
        html: '<p>raw html</p>',
    });
});

test('extractGmailBodies: first match wins per type', () => {
    const payload = {
        parts: [
            { mimeType: 'text/plain', body: { data: b64('first') } },
            { mimeType: 'text/plain', body: { data: b64('second') } },
        ],
    };
    assert.strictEqual(extractGmailBodies(payload).text, 'first');
});
