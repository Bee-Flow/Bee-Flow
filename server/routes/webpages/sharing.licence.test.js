/**
 * Webpage sharing and its licence (`webpage_sharing`, the enterprise split of
 * 2026-10), through the real webpages router.
 *
 * Personal webpages are Community; sharing one is Enterprise. Pinned here,
 * route by route, from both sides of the house rule:
 *
 *   PATCH /:id/publish           a first publish, another group, or groups
 *                                becoming the whole organisation is refused;
 *                                unpublishing, dropping groups, narrowing and
 *                                republishing for the same audience are not.
 *   POST /:id/public-shares      a new link is refused; refreshing and
 *                                revoking an existing one are not.
 *   PATCH /:id/public-shares/:s  a later expiry is refused, an earlier one not.
 *   PUT /:id/audience/public     making a page public, or a public page wider,
 *                                is refused; turning it off, and saving it as
 *                                it is, are not.
 *
 * A refusal is the standard 403 body and comes before anything is written.
 * The gate is the one seam in ./sharingGate (`requireSharing`), replaced
 * here the way these route tests replace store functions.
 *
 * Run: cd server && node --test routes/webpages/sharing.licence.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const perms = require('../../auth/permissions');
perms.requireAuth = (req, res, next) => next();
const auth = require('../../auth');
auth.requireActiveOrgForMutations = () => (req, res, next) => next();
auth.validateSharedGroupsForOrg = async (_org, groups) => (Array.isArray(groups) ? groups : []);
auth.hasPermission = async () => false;
const audienceAuth = require('../../auth/audience');
audienceAuth.resolveAudienceContext = async (req) => ({ userId: req.session.user.id, orgIds: ['org1'], userGroups: [] });

const webpageStore = require('../../stores/webpageStore');
const webpageDbStore = require('../../stores/webpageDbStore');
const publicShareStore = require('../../stores/webpagePublicShareStore');
const publicAddress = require('../../stores/webpage/publicAddress');
const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const projectStore = require('../../stores/projectStore');
const datatableAccess = require('../../auth/datatableAccess');
const webpageSnapshot = require('../../services/webpageSnapshot');
const usageSync = require('../../core/webpages/webpageUsageSync');
const sharingGate = require('./sharingGate');

const webpagesRouter = require('../webpages');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

const OWNER = { id: 'alice', organizationId: 'org1' };
const BASE = {
    id: 'wp1', userId: 'alice', name: 'Prijslijst', isPublished: false, sharedGroups: [],
    organizationId: 'org1', publishedVersionId: null, projectId: null, slug: null, publicShareId: null,
    htmlSha: 'h1', cssSha: 'c1', jsSha: 'j1', dbSha: '', settings: {},
};

// ── the world the routes see ──────────────────────────────────────────

let page = { ...BASE };
let licensed = false;
let gateAsked = 0;
let writes = [];
let liveShare = null;          // what findLiveShareById answers
let liveShareThrows = false;
let share = null;              // what getShareById answers
let tables = [];

const wrote = (what) => (...args) => { writes.push(what); return args; };

function patches() {
    return [
        [sharingGate, 'requireSharing', (req, res, next) => {
            gateAsked += 1;
            if (licensed) return next();
            return res.status(403).json({ error: 'feature_locked', feature: 'webpage_sharing', required: 'enterprise', current: 'community' });
        }],
        [webpageStore, 'getWebpageRaw', async () => ({ ...page })],
        [webpageStore, 'getWebpage', async (id, userId) => (userId === page.userId ? { ...page } : null)],
        [webpageStore, 'setWebpagePublished', async (...a) => { wrote('setWebpagePublished')(...a); return true; }],
        [webpageStore, 'setPublishedVersion', async (...a) => { wrote('setPublishedVersion')(...a); return true; }],
        [webpageStore, 'createVersion', async (...a) => { wrote('createVersion')(...a); return { id: 'v-new' }; }],
        [webpageDbStore, 'flush', async () => {}],
        [usageSync, 'reconcileWebpageUsageDetached', () => {}],
        [publicShareStore, 'createShare', async (...a) => { wrote('createShare')(...a); return { share: { id: 'sh_new' }, rawToken: 'raw' }; }],
        [publicShareStore, 'getShareById', async () => (share ? { ...share } : null)],
        [publicShareStore, 'findLiveShareById', async () => { if (liveShareThrows) throw new Error('db down'); return liveShare ? { ...liveShare } : null; }],
        [publicShareStore, 'updateExpiry', async (...a) => { wrote('updateExpiry')(...a); return true; }],
        [publicShareStore, 'revokeShare', async (...a) => { wrote('revokeShare')(...a); }],
        [publicShareStore, 'deleteShare', async () => {}],
        [publicShareStore, 'listSharesForWebpage', async () => []],
        [publicShareStore, 'getRetrievableTokens', async () => new Map()],
        [publicAddress, 'clearCanonicalShare', async () => {}],
        [publicAddress, 'ensureSlug', async () => 'prijslijst-k3f9x2mq7bd4'],
        [publicAddress, 'setCanonicalShare', async (...a) => { wrote('setCanonicalShare')(...a); return true; }],
        [bridgeGrants, 'getBridgeGrants', async () => ({ tables: tables.map(t => ({ ...t })) })],
        [bridgeGrants, 'updateBridgeGrants', async (id, uid, patch) => { writes.push('updateBridgeGrants'); return { tables: patch.tables }; }],
        [projectStore, 'getProject', async () => null],
        [datatableAccess, 'resolveDatatablePrincipalForUser', async () => { throw new Error('no principal in this test'); }],
        [webpageSnapshot, 'writeSnapshot', async (...a) => { wrote('writeSnapshot')(...a); }],
    ];
}

let base = null;
test.before(async (t) => {
    const originals = patches().map(([obj, key, value]) => {
        const orig = obj[key];
        obj[key] = value;
        return [obj, key, orig];
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { ...OWNER } }; next(); });
    app.use(webpagesRouter);
    app.use(terminalErrorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        server.close();
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
});

test.beforeEach(() => {
    page = { ...BASE };
    licensed = false;
    gateAsked = 0;
    writes = [];
    liveShare = null;
    liveShareThrows = false;
    share = null;
    tables = [];
});

async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: parsed };
}

function assertLocked(res, what) {
    assert.strictEqual(res.status, 403, `${what} → ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'feature_locked', what);
    assert.strictEqual(res.body.feature, 'webpage_sharing', what);
}

// ═══ PATCH /:id/publish ═════════════════════════════════════════════

test('publish: handing a personal page to the organisation or to a group is refused, and nothing is pinned or written', async () => {
    for (const body of [{ isPublished: true, sharedGroups: [] }, { isPublished: true, sharedGroups: ['g1'] }, { isPublished: true }]) {
        assertLocked(await call('PATCH', '/wp1/publish', body), JSON.stringify(body));
    }
    assert.deepStrictEqual(writes, [], 'no snapshot, no pointer, no flag');
});

test('publish: another group, or groups becoming the whole organisation, is refused', async () => {
    page = { ...BASE, isPublished: true, sharedGroups: ['g1'], publishedVersionId: 'v1' };
    assertLocked(await call('PATCH', '/wp1/publish', { isPublished: true, sharedGroups: ['g1', 'g2'] }), 'add a group');
    assertLocked(await call('PATCH', '/wp1/publish', { isPublished: true, sharedGroups: [] }), 'groups → organisation');
    assert.deepStrictEqual(writes, []);
});

test('publish: unpublishing, dropping a group, narrowing and republishing stay open without the licence', async () => {
    page = { ...BASE, isPublished: true, sharedGroups: ['g1', 'g2'], publishedVersionId: 'v1' };
    let res = await call('PATCH', '/wp1/publish', { isPublished: true, sharedGroups: ['g1'] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    res = await call('PATCH', '/wp1/publish', { isPublished: true, sharedGroups: ['g1', 'g2'], republish: true });
    assert.strictEqual(res.status, 200, 'republishing for the audience the page has is not widening');

    page = { ...BASE, isPublished: true, sharedGroups: [], publishedVersionId: 'v1' };
    res = await call('PATCH', '/wp1/publish', { isPublished: true, sharedGroups: ['g1'] });
    assert.strictEqual(res.status, 200, 'the organisation narrowed to one group');

    res = await call('PATCH', '/wp1/publish', { isPublished: false });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(gateAsked, 0, 'none of these even asked');
    assert.ok(writes.includes('setWebpagePublished'));
});

test('publish: with the licence a personal page goes to the organisation', async () => {
    licensed = true;
    const res = await call('PATCH', '/wp1/publish', { isPublished: true, sharedGroups: [] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(gateAsked, 1);
    assert.ok(writes.includes('createVersion') && writes.includes('setWebpagePublished'));
});

// ═══ public share links ════════════════════════════════════════════

test('links: a new public link is refused without the licence, before a share or a snapshot exists', async () => {
    assertLocked(await call('POST', '/wp1/public-shares', { accessMode: 'unlisted' }), 'new link');
    assert.deepStrictEqual(writes, []);
    licensed = true;
    const res = await call('POST', '/wp1/public-shares', { accessMode: 'unlisted' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(writes, ['createShare', 'writeSnapshot']);
});

test('links: an existing link can be refreshed and revoked without the licence', async () => {
    share = { id: 'sh1', webpageId: 'wp1', createdBy: 'alice', revokedAt: null, expiresAt: null };
    const refreshed = await call('POST', '/wp1/public-shares/sh1/refresh');
    assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.body));
    const revoked = await call('DELETE', '/wp1/public-shares/sh1');
    assert.strictEqual(revoked.status, 200, JSON.stringify(revoked.body));
    assert.deepStrictEqual(writes, ['writeSnapshot', 'revokeShare']);
    assert.strictEqual(gateAsked, 0);
});

test('links: a later expiry is refused, an earlier one is not', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString();
    share = { id: 'sh1', webpageId: 'wp1', createdBy: 'alice', revokedAt: null, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() };

    assertLocked(await call('PATCH', '/wp1/public-shares/sh1', { expiresAt: later }), 'later');
    assertLocked(await call('PATCH', '/wp1/public-shares/sh1', { expiresAt: null }), 'no expiry');
    assert.deepStrictEqual(writes, []);

    const earlier = await call('PATCH', '/wp1/public-shares/sh1', { expiresAt: soon });
    assert.strictEqual(earlier.status, 200, JSON.stringify(earlier.body));
    assert.deepStrictEqual(writes, ['updateExpiry']);

    licensed = true;
    const extended = await call('PATCH', '/wp1/public-shares/sh1', { expiresAt: later });
    assert.strictEqual(extended.status, 200, JSON.stringify(extended.body));
});

// ═══ PUT /:id/audience/public ══════════════════════════════════════

const PUBLIC_PAGE = { ...BASE, slug: 'prijslijst-k3f9x2mq7bd4', publicShareId: 'sh1' };
const LIVE = { id: 'sh1', webpageId: 'wp1', createdBy: 'alice', accessMode: 'unlisted', allowedEmails: null, expiresAt: null };

test('public: making a page public is refused, and the column choice stays as it was', async () => {
    tables = [{ datatableId: 't1', columns: ['name', 'price'], publicColumns: [] }];
    assertLocked(await call('PUT', '/wp1/audience/public', { on: true, publicColumns: { t1: ['name'] } }), 'turn on');
    assert.deepStrictEqual(writes, [], 'no column choice, no share, no snapshot, no address');
});

test('public: letting out another column on a public page is refused', async () => {
    page = { ...PUBLIC_PAGE };
    liveShare = { ...LIVE };
    tables = [{ datatableId: 't1', columns: ['name', 'price'], publicColumns: ['name'] }];
    assertLocked(await call('PUT', '/wp1/audience/public', { on: true, publicColumns: { t1: ['name', 'price'] }, accessMode: 'unlisted', allowedEmails: [], expiresAt: null }), 'more columns');
    assert.deepStrictEqual(writes, []);
});

test('public: when the current link cannot be read, nothing is published without the licence', async () => {
    page = { ...PUBLIC_PAGE };
    liveShareThrows = true;
    assertLocked(await call('PUT', '/wp1/audience/public', { on: true, publicColumns: {} }), 'unknown state');
    assert.deepStrictEqual(writes, []);
});

test('public: saving a public page as it is, or with fewer columns, stays open without the licence', async () => {
    page = { ...PUBLIC_PAGE };
    liveShare = { ...LIVE };
    tables = [{ datatableId: 't1', columns: ['name', 'price'], publicColumns: ['name', 'price'] }];
    const res = await call('PUT', '/wp1/audience/public', { on: true, publicColumns: { t1: ['name'] }, accessMode: 'unlisted', allowedEmails: [], expiresAt: null });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(gateAsked, 0);
    assert.ok(writes.includes('updateBridgeGrants') && writes.includes('writeSnapshot'));
    assert.ok(!writes.includes('createShare'), 'the existing link is kept');
});

test('public: turning public off is never gated', async () => {
    page = { ...PUBLIC_PAGE };
    share = { ...LIVE, revokedAt: null };
    const res = await call('PUT', '/wp1/audience/public', { on: false });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(gateAsked, 0);
    assert.ok(writes.includes('revokeShare'));
});

test('public: with the licence a page is made public', async () => {
    licensed = true;
    const res = await call('PUT', '/wp1/audience/public', { on: true, publicColumns: {} });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(gateAsked, 1);
    assert.ok(writes.includes('createShare') && writes.includes('setCanonicalShare'));
});
