'use strict';
/**
 * BFSF-390 - clone uses the ASYNC read gate (project-membership reads), like
 * its siblings. A page readable only through the async gate can be cloned; a
 * page the async gate refuses answers 404.
 *
 * Run: node --test routes/webpages/lifecycle.clone.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const webpageStore = require('../../stores/webpageStore');
const webpageDbStore = require('../../stores/webpageDbStore');
const audience = require('../../auth/audience');
const usageSync = require('../../core/webpages/webpageUsageSync');
const { register } = require('./lifecycle');

function handler() {
    let h;
    register({ post: (p, ...fns) => { if (p === '/:id/clone') h = fns[fns.length - 1]; }, delete: () => {} });
    return h;
}

function run(allowed) {
    const orig = {
        raw: webpageStore.getWebpageRaw, sync: webpageStore.canReadWebpage, async: webpageStore.canReadWebpageAsync,
        clone: webpageStore.cloneWebpage, flush: webpageDbStore.flush, ctx: audience.resolveAudienceContext,
        rec: usageSync.reconcileWebpageUsageDetached,
    };
    webpageStore.getWebpageRaw = async () => ({ id: 'wp1', userId: 'owner' });
    webpageStore.canReadWebpage = () => false; // the old sync gate would refuse
    webpageStore.canReadWebpageAsync = async () => allowed;
    webpageStore.cloneWebpage = async () => ({ id: 'wp2' });
    webpageDbStore.flush = async () => {};
    usageSync.reconcileWebpageUsageDetached = () => {};
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const restore = () => {
        webpageStore.getWebpageRaw = orig.raw; webpageStore.canReadWebpage = orig.sync; webpageStore.canReadWebpageAsync = orig.async;
        webpageStore.cloneWebpage = orig.clone; webpageDbStore.flush = orig.flush; usageSync.reconcileWebpageUsageDetached = orig.rec;
    };
    return { res, restore };
}

test('clone is allowed when the async gate allows (sync gate ignored)', async (t) => {
    // resolveAudienceContext is destructured at module load, so drive it via a session-shaped req.
    const { res, restore } = run(true);
    t.after(restore);
    const req = { params: { id: 'wp1' }, body: {}, session: { user: { id: 'bob' } } };
    await handler()(req, res).catch(() => {});
    assert.equal(res.body?.success, true, `got ${res.code} ${JSON.stringify(res.body)}`);
});

test('clone answers 404 when the async gate refuses', async (t) => {
    const { res, restore } = run(false);
    t.after(restore);
    const req = { params: { id: 'wp1' }, body: {}, session: { user: { id: 'bob' } } };
    await handler()(req, res).catch(() => {});
    assert.equal(res.code, 404);
});
