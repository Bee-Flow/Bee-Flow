/**
 * Studio → Forms, what an EDITOR sees of a form that is not (all) live yet
 * (studio F11), and the form's test link (D3):
 *
 *   - editorFormFacts: the changes not live yet, the live and working versions
 *     (Publish's version check), and the test link, never the row;
 *   - GET/POST/DELETE /forms/:automationId/test-link and PUT .../audience: a
 *     new link is the maker's alone and expires; edit is checked BEFORE the
 *     body is read; an automation without a form answers 404.
 *
 * The routes on a real express app (testUtils/routeHarness.js serve) with the
 * store and the access check handed in (no module mocks).
 * Run: cd server && node --test routes/automation/forms.pendingChanges.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const h = require('../../testUtils/routeHarness');
const { registerFormTestLinkRoutes, editorFormFacts } = require('./formTestLink');

const EDITOR = { id: 'ed1', organizationId: 'org1' };
const VIEWER = { id: 'viewer1', organizationId: 'org1' };
const FORM_AUTOMATION = { id: 'au1', userId: 'owner1', organizationId: 'org1', definition: { trigger: { id: 't', kind: 'form', form: {} } }, pendingChanges: 2, liveVersion: 3, version: 5 };

let pages;
let audienceWrites;
const store = {
    getAutomation: async (id) => (id === 'au1' ? FORM_AUTOMATION : id === 'au-manual' ? { ...FORM_AUTOMATION, id, definition: { trigger: { kind: 'manual' } } } : null),
    getTestFormPage: async (automationId) => pages.find((p) => p.automationId === automationId && !p.revoked) || null,
    createTestFormPage: async (automationId, opts) => {
        for (const p of pages) if (p.automationId === automationId) p.revoked = true;
        const page = {
            id: `tok${pages.length + 1}`.padEnd(48, '0'), automationId, triggerStepId: null, isTest: true, createdAt: 'now',
            issuedByUserId: opts.issuedByUserId, expiresAt: opts.expiresAt, audience: opts.audience, sharedGroups: opts.sharedGroups, sharedUserIds: opts.sharedUserIds,
        };
        pages.push(page);
        return page;
    },
    revokeTestFormPages: async (automationId) => {
        const live = pages.filter((p) => p.automationId === automationId && !p.revoked);
        for (const p of live) p.revoked = true;
        return live.length;
    },
    setFormPageAudience: async (id, automationId, wanted) => {
        audienceWrites.push({ id, automationId, ...wanted });
        const p = pages.find((x) => x.id === id);
        Object.assign(p, wanted);
        return p;
    },
};
// Edit for ed1 only; the guard answers like automation/access does.
const access = {
    guard: async (req, res, _a, need) => {
        if (req.session.user.id === EDITOR.id) return { role: 'edit' };
        res.status(403).json({ error: 'Forbidden', code: 'automation_forbidden', need });
        return null;
    },
};
const readAudienceBody = async (body) => ({ audience: body.audience, sharedGroups: body.sharedGroups, sharedUserIds: body.sharedUserIds });

const router = express.Router();
registerFormTestLinkRoutes(router, { readAudienceBody, store, access, orgOf: async () => 'org1' });
const api = h.serve('/api/automation', router, { user: EDITOR });
after(api.close);
beforeEach(() => { pages = []; audienceWrites = []; });

test('editorFormFacts: the changes not live, the versions, and the test link as an allow-list', async () => {
    assert.deepStrictEqual(await editorFormFacts('au1', { store }), { pendingChanges: 2, liveVersion: 3, version: 5, testLink: null });
    await store.createTestFormPage('au1', { issuedByUserId: 'ed1', expiresAt: null, audience: 'restricted', sharedGroups: [], sharedUserIds: ['ed1'] });
    const { testLink } = await editorFormFacts('au1', { store });
    assert.deepStrictEqual(Object.keys(testLink).sort(), ['audience', 'createdAt', 'expiresAt', 'issuedByUserId', 'token', 'url']);
    assert.strictEqual(testLink.url, `/f/${testLink.token}`);
    assert.deepStrictEqual(testLink.audience, { mode: 'restricted', groups: [], users: ['ed1'] });
});

test('an editor makes a test link: the maker\'s alone, expiring; a new one replaces it; revoke stops it', async () => {
    const made = await api.call('POST', '/api/automation/forms/au1/test-link');
    assert.strictEqual(made.status, 201, made.text);
    const link = made.body.testLink;
    assert.deepStrictEqual(link.audience, { mode: 'restricted', groups: [], users: ['ed1'] });
    assert.strictEqual(link.issuedByUserId, 'ed1');
    const days = (new Date(link.expiresAt).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 13.9 && days <= 14, `expires in 14 days by default (${days})`);

    const read = await api.call('GET', '/api/automation/forms/au1/test-link');
    assert.strictEqual(read.body.testLink.token, link.token);

    const again = await api.call('POST', '/api/automation/forms/au1/test-link');
    assert.notStrictEqual(again.body.testLink.token, link.token);
    assert.strictEqual((await api.call('GET', '/api/automation/forms/au1/test-link')).body.testLink.token, again.body.testLink.token);

    const widened = await api.call('PUT', '/api/automation/forms/au1/test-link/audience', { body: { audience: 'restricted', sharedUserIds: ['ed1', 'pat'] } });
    assert.strictEqual(widened.status, 200, widened.text);
    assert.deepStrictEqual(widened.body.testLink.audience.users, ['ed1', 'pat']);
    assert.strictEqual(audienceWrites[0].id, again.body.testLink.token);

    const revoked = await api.call('DELETE', '/api/automation/forms/au1/test-link');
    assert.deepStrictEqual(revoked.body, { revoked: true });
    assert.strictEqual((await api.call('GET', '/api/automation/forms/au1/test-link')).body.testLink, null);
    const none = await api.call('PUT', '/api/automation/forms/au1/test-link/audience', { body: { audience: 'org' } });
    assert.strictEqual(none.status, 404);
});

test('without edit every route is refused before the body is read; no form, no test link', async () => {
    for (const [method, url, body] of [
        ['GET', '/api/automation/forms/au1/test-link'],
        ['POST', '/api/automation/forms/au1/test-link'],
        ['DELETE', '/api/automation/forms/au1/test-link'],
        ['PUT', '/api/automation/forms/au1/test-link/audience', { nonsense: true }],
    ]) {
        const res = await api.call(method, url, { user: VIEWER, body });
        assert.strictEqual(res.status, 403, `${method} ${url}: ${res.status}`);
    }
    assert.strictEqual(pages.length, 0);
    assert.strictEqual((await api.call('POST', '/api/automation/forms/au-manual/test-link')).status, 404);
    assert.strictEqual((await api.call('POST', '/api/automation/forms/nope/test-link')).status, 404);
});

test('making a test link takes no fields: one sent is refused by name, nothing is made', async () => {
    const res = await api.call('POST', '/api/automation/forms/au1/test-link', { body: { audience: 'org' } });
    h.assertRefused(assert, res, 'body', /Making a test link does not take "audience"/);
    assert.deepStrictEqual(pages, []);
});
