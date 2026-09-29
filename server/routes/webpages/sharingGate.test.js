/**
 * routes/webpages/sharingGate: which webpage requests WIDEN who can see a
 * page, and the in-handler form of the licence gate.
 *
 * The rule is the house rule of the enterprise split (2026-10): only new
 * sharing or widening needs `webpage_sharing`; what exists keeps working, and
 * taking access away is never gated. Every "false" below is a request a
 * Community organisation must still be able to make.
 *
 * Run: cd server && node --test routes/webpages/sharingGate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const gate = require('./sharingGate');

const PERSONAL = { isPublished: false, sharedGroups: [] };
const ORG = { isPublished: true, sharedGroups: [] };
const GROUPS = { isPublished: true, sharedGroups: ['g1', 'g2'] };

// ── PATCH /:id/publish ─────────────────────────────────────────────────

test('publishing a page that is not published widens, to the organisation or to groups', () => {
    assert.strictEqual(gate.publishWidens(PERSONAL, { isPublished: true, sharedGroups: [] }), true);
    assert.strictEqual(gate.publishWidens(PERSONAL, { isPublished: true, sharedGroups: ['g1'] }), true);
    assert.strictEqual(gate.publishWidens(PERSONAL, { isPublished: true }), true);
    assert.strictEqual(gate.publishWidens(null, { isPublished: true }), true);
});

test('another group, or groups becoming the whole organisation, widens', () => {
    assert.strictEqual(gate.publishWidens(GROUPS, { isPublished: true, sharedGroups: ['g1', 'g2', 'g3'] }), true);
    assert.strictEqual(gate.publishWidens(GROUPS, { isPublished: true, sharedGroups: ['g3'] }), true);
    assert.strictEqual(gate.publishWidens(GROUPS, { isPublished: true, sharedGroups: [] }), true);
});

test('unpublishing, dropping groups and narrowing the organisation to groups never widen', () => {
    assert.strictEqual(gate.publishWidens(ORG, { isPublished: false, sharedGroups: [] }), false);
    assert.strictEqual(gate.publishWidens(GROUPS, { isPublished: false }), false);
    assert.strictEqual(gate.publishWidens(PERSONAL, { isPublished: false }), false);
    assert.strictEqual(gate.publishWidens(GROUPS, { isPublished: true, sharedGroups: ['g1'] }), false);
    assert.strictEqual(gate.publishWidens(ORG, { isPublished: true, sharedGroups: ['g1'] }), false);
});

test('republishing for the audience the page already has does not widen', () => {
    // The header's Republish sends the current groups; an omitted list keeps them.
    assert.strictEqual(gate.publishWidens(ORG, { isPublished: true, sharedGroups: [] }), false);
    assert.strictEqual(gate.publishWidens(GROUPS, { isPublished: true, sharedGroups: ['g2', 'g1'] }), false);
    assert.strictEqual(gate.publishWidens(GROUPS, { isPublished: true }), false);
});

// ── expiry ──────────────────────────────────────────────────────────────

test('a later date, no date, or reopening an expired link extends it', () => {
    assert.strictEqual(gate.expiryExtends('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), true);
    assert.strictEqual(gate.expiryExtends('2026-10-01T00:00:00Z', null), true);
    assert.strictEqual(gate.expiryExtends('2020-01-01T00:00:00Z', new Date('2030-01-01T00:00:00Z')), true);
});

test('an earlier date, or a date on a link that had none, does not', () => {
    assert.strictEqual(gate.expiryExtends('2026-11-01T00:00:00Z', '2026-10-01T00:00:00Z'), false);
    assert.strictEqual(gate.expiryExtends('2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'), false);
    assert.strictEqual(gate.expiryExtends(null, '2026-10-01T00:00:00Z'), false);
    assert.strictEqual(gate.expiryExtends(null, null), false);
});

// ── PUT /:id/audience/public ────────────────────────────────────────────

const TABLES = [{ datatableId: 't1', columns: ['name', 'price', 'cost'], publicColumns: ['name'] }];
const LIVE = { id: 'sh1', accessMode: 'password', allowedEmails: null, expiresAt: '2026-12-01T00:00:00.000Z' };

test('turning public on widens', () => {
    assert.strictEqual(gate.publicRequestWidens({ existing: null, currentTables: TABLES, body: { on: true, publicColumns: {} } }), true);
});

test('on a public page: another column, a later expiry or weaker protection widens', () => {
    const w = (body) => gate.publicRequestWidens({ existing: LIVE, currentTables: TABLES, body: { on: true, publicColumns: { t1: ['name'] }, ...body } });
    assert.strictEqual(w({ publicColumns: { t1: ['name', 'price'] } }), true);
    assert.strictEqual(w({ expiresAt: '2027-01-01' }), true);
    assert.strictEqual(w({ expiresAt: null }), true);
    assert.strictEqual(w({ accessMode: 'unlisted' }), true);
    const email = { ...LIVE, accessMode: 'email', allowedEmails: ['a@x.nl'] };
    assert.strictEqual(gate.publicRequestWidens({ existing: email, currentTables: TABLES, body: { on: true, publicColumns: { t1: ['name'] }, accessMode: 'password', password: 'secret1' } }), true);
    assert.strictEqual(gate.publicRequestWidens({ existing: email, currentTables: TABLES, body: { on: true, publicColumns: { t1: ['name'] }, accessMode: 'email', allowedEmails: ['a@x.nl', 'b@x.nl'] } }), true);
});

test('on a public page: the same settings, fewer columns, an earlier expiry or stronger protection do not', () => {
    const w = (body) => gate.publicRequestWidens({ existing: LIVE, currentTables: TABLES, body: { on: true, publicColumns: { t1: ['name'] }, ...body } });
    // What the screen sends when nothing changed: the date as a day, the mode, the list.
    assert.strictEqual(w({ accessMode: 'password', allowedEmails: [], expiresAt: '2026-12-01' }), false);
    assert.strictEqual(w({ publicColumns: {} }), false);
    assert.strictEqual(w({ publicColumns: { t1: ['name', 'not-a-column'] } }), false, 'a column the binding does not read is dropped, as the route drops it');
    assert.strictEqual(w({ expiresAt: '2026-11-01' }), false);
    assert.strictEqual(w({ accessMode: 'email', allowedEmails: ['a@x.nl'] }), false);
    assert.strictEqual(w({ password: 'a-new-one' }), false, 'a new password is a rotation, not a widening');
    const email = { ...LIVE, accessMode: 'email', allowedEmails: ['a@x.nl', 'B@x.nl'] };
    assert.strictEqual(gate.publicRequestWidens({ existing: email, currentTables: TABLES, body: { on: true, publicColumns: { t1: ['name'] }, accessMode: 'email', allowedEmails: ['b@x.nl'] } }), false);
});

// ── the in-handler gate ─────────────────────────────────────────────────

function fakeRes() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('allow() resolves true when the gate lets the request through, false when it answered', async () => {
    const real = gate.requireSharing;
    try {
        gate.requireSharing = (req, res, next) => next();
        assert.strictEqual(await gate.allow({}, fakeRes()), true);

        gate.requireSharing = async (req, res) => { res.status(403).json({ error: 'feature_locked', feature: 'webpage_sharing' }); };
        const res = fakeRes();
        assert.strictEqual(await gate.allow({}, res), false);
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.body.feature, 'webpage_sharing');

        gate.requireSharing = async (req, res, next) => { await Promise.resolve(); return next(); };
        assert.strictEqual(await gate.allow({}, fakeRes()), true, 'an asynchronous pass is a pass');
    } finally {
        gate.requireSharing = real;
    }
});

test('the real gate asks for webpage_sharing', async () => {
    // An unauthenticated session is let through by requireCapability itself
    // (the auth middleware answers it), which proves the real middleware is
    // wired without resolving any entitlements here.
    assert.strictEqual(gate.CAPABILITY, 'webpage_sharing');
    assert.strictEqual(await gate.allow({ session: {} }, fakeRes()), true);
});
