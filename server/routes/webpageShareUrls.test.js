/**
 * BFSF-186 — "Cannot retrieve or copy the URL of a webpage created by another
 * user". A reader who could open a colleague's published page saw that share
 * links existed but never the URL, so the page could not be passed on.
 *
 * The behaviour landed with BFSF-188 (token ciphertext at rest +
 * read-visibility for non-owners) but shipped with no colocated test, so
 * nothing pinned it — and every regression here is SILENT: the endpoint keeps
 * answering 200 and the UI just falls back to "link held by owner".
 *
 * Run: cd server && node --test routes/webpageShareUrls.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    listingCreatorScope,
    stripOwnerOnlyFields,
    isShareLinkable,
    attachShareUrls,
} = require('./webpageShareUrls');

const buildUrl = (raw) => `https://beeflow.nl/share/${raw}`;
const NOW = Date.parse('2026-08-11T12:00:00.000Z');

const LIVE = { id: 'live', createdBy: 'owner-1', allowedEmails: ['finance@acme.test'], revokedAt: null, expiresAt: null };
const REVOKED = { id: 'dead', createdBy: 'owner-1', allowedEmails: [], revokedAt: '2026-01-01T00:00:00.000Z', expiresAt: null };
const EXPIRED = { id: 'old', createdBy: 'owner-1', allowedEmails: [], revokedAt: null, expiresAt: '2026-08-01T00:00:00.000Z' };
const FUTURE = { id: 'soon', createdBy: 'owner-1', allowedEmails: [], revokedAt: null, expiresAt: '2026-09-01T00:00:00.000Z' };

// ── Listing scope: the half that made the link invisible ─────────────

test('a non-owner lists EVERY share on the page, not just their own', () => {
    // This is the bug. Scoping a reader's query to their own user id returns
    // an empty list for a page they did not create — exactly the case.
    assert.strictEqual(listingCreatorScope(false, 'reader-2'), null);
});

test('the owner keeps the owner-scoped listing', () => {
    assert.strictEqual(listingCreatorScope(true, 'owner-1'), 'owner-1');
});

// ── The URL itself ───────────────────────────────────────────────────

test('a reader gets a real, copyable URL for a colleague\'s live share', () => {
    const [row] = attachShareUrls([LIVE], { live: 'raw-abc' }, buildUrl, NOW);
    assert.strictEqual(row.url, 'https://beeflow.nl/share/raw-abc');
});

test('a revoked share reports url: null even when its token still decrypts', () => {
    const [row] = attachShareUrls([REVOKED], { dead: 'raw-dead' }, buildUrl, NOW);
    assert.strictEqual(row.url, null);
});

test('an expired share reports url: null', () => {
    const [row] = attachShareUrls([EXPIRED], { old: 'raw-old' }, buildUrl, NOW);
    assert.strictEqual(row.url, null);
});

test('a share that has not expired yet still gets its URL', () => {
    const [row] = attachShareUrls([FUTURE], { soon: 'raw-soon' }, buildUrl, NOW);
    assert.strictEqual(row.url, 'https://beeflow.nl/share/raw-soon');
});

test('a legacy share with no recoverable token degrades to url: null', () => {
    const [row] = attachShareUrls([LIVE], {}, buildUrl, NOW);
    assert.strictEqual(row.url, null);
});

test('a missing token map is survivable, not a crash', () => {
    const [row] = attachShareUrls([LIVE], null, buildUrl, NOW);
    assert.strictEqual(row.url, null);
});

test('every share keeps its other fields and the list keeps its order', () => {
    const rows = attachShareUrls([LIVE, REVOKED, EXPIRED], { live: 'raw-abc' }, buildUrl, NOW);
    assert.deepStrictEqual(rows.map(r => r.id), ['live', 'dead', 'old']);
    assert.strictEqual(rows[0].createdBy, 'owner-1');
});

test('an unparseable expiry fails closed', () => {
    assert.strictEqual(isShareLinkable({ id: 'x', expiresAt: 'not-a-date' }, NOW), false);
});

test('expiry is inclusive at the boundary, dead one ms later', () => {
    const at = { id: 'x', revokedAt: null, expiresAt: new Date(NOW).toISOString() };
    assert.strictEqual(isShareLinkable(at, NOW), true);
    assert.strictEqual(isShareLinkable(at, NOW + 1), false);
});

// ── What must NOT travel with the URL ────────────────────────────────

test('the URL reaches a non-owner but the recipient allow-list does not', () => {
    const [row] = attachShareUrls(
        stripOwnerOnlyFields([LIVE], false), { live: 'raw-abc' }, buildUrl, NOW);
    assert.ok(row.url, 'the reader still gets the link — that is the fix');
    assert.ok(!('allowedEmails' in row),
        'the owner\'s chosen recipients must never leak to other org members');
});

test('the owner still sees their own recipient allow-list', () => {
    const [row] = stripOwnerOnlyFields([LIVE], true);
    assert.deepStrictEqual(row.allowedEmails, ['finance@acme.test']);
});
