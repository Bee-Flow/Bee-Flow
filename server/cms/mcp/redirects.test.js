'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { REDIRECT_TOOLS, createRedirectHandlers } = require('./redirects');
const rules = require('../../stores/cms/redirectRules');

/** A cmsStore stand-in over the real rules, so the tool sees the real refusals. */
function fakeStore() {
    const doc = { redirects: [], allowedHosts: ['partner.example'] };
    return {
        getRedirects: async () => doc,
        setRedirect: async (_s, input) => {
            doc.redirects = rules.addRedirect(doc.redirects, input, { allowedHosts: doc.allowedHosts });
            return { entry: doc.redirects.find((r) => r.from === rules.normalizeFrom(input.from)), redirects: doc.redirects };
        },
        removeRedirect: async (_s, id) => { const n = doc.redirects.length; doc.redirects = doc.redirects.filter((r) => r.id !== id); return n !== doc.redirects.length; },
    };
}
const audits = [];
const setup = () => createRedirectHandlers({ cmsStore: fakeStore(), resolveSite: async () => ({ siteId: 'pj_1' }), audit: async (...a) => { audits.push(a); } }).handlers;
const ctx = { userId: 'u1', orgId: 'o1', token: { name: 'tok' } };

test('three tools: list is read-only, set writes, delete is destructive', () => {
    assert.deepEqual(REDIRECT_TOOLS.map((t) => t.name), ['cms_list_redirects', 'cms_set_redirect', 'cms_delete_redirect']);
    assert.equal(REDIRECT_TOOLS[0].readOnly, true);
    assert.equal(REDIRECT_TOOLS[1].readOnly, false);
    assert.equal(REDIRECT_TOOLS[2].destructive, true);
});

test('set, list and delete a redirect', async () => {
    const h = setup();
    const set = await h.cms_set_redirect({ from: 'Old-Page', to: '/new-page' }, ctx);
    assert.equal(set.result.redirect.from, '/old-page');
    assert.equal((await h.cms_list_redirects({})).result.count, 1);
    const del = await h.cms_delete_redirect({ from: '/old-page/' }, ctx);
    assert.equal(del.result.deleted.from, '/old-page');
    assert.equal((await h.cms_list_redirects({})).result.count, 0);
});

test('a loop, an open redirect and an unknown field are refused with a sentence', async () => {
    const h = setup();
    await h.cms_set_redirect({ from: '/aa', to: '/bb' });
    assert.equal((await h.cms_set_redirect({ from: '/bb', to: '/aa' })).result.code, 'loop');
    assert.ok((await h.cms_set_redirect({ from: '/cc', to: '//evil.example' })).result.error);
    assert.equal((await h.cms_set_redirect({ from: '/cc', to: 'https://other.example/', external: true })).result.code, 'to_host_not_allowed');
    assert.match((await h.cms_set_redirect({ from: '/cc', to: '/dd', allowedHosts: ['evil.example'] })).result.error, /Unknown field/);
});

test('deleting an unknown redirect says what exists', async () => {
    const h = setup();
    assert.ok((await h.cms_delete_redirect({ from: '/nope' })).result._fixHint);
});

test('set and delete are audited with ids and addresses, an external target only as its host', async () => {
    audits.length = 0;
    const h = setup();
    await h.cms_set_redirect({ from: '/pp', to: 'https://partner.example/x?token=secret', external: true }, ctx);
    await h.cms_delete_redirect({ from: '/pp' }, ctx);
    assert.deepEqual(audits.map((a) => a[0]), ['cms.redirect.set.mcp', 'cms.redirect.delete.mcp']);
    const details = audits[0][5];
    assert.equal(details.host, 'partner.example');
    assert.ok(!JSON.stringify(audits).includes('secret'));
    assert.deepEqual([details.siteId, details.from, details.external, audits[0][3]], ['pj_1', '/pp', true, 'u1']);
});
