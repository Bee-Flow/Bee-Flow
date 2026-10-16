'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LINK_TOOLS, createLinkHandlers, EXTERNAL_MAX_PER_WINDOW } = require('./linkHandlers');
const { createTakeBudget } = require('./handlerKit');

const cmsStore = {
    getAdminPayload: async () => ({ site: { pages: [{ id: 'pg_1', slug: 'home' }], footer: { l: { kind: 'page', pageId: 'gone' } } }, pages: [], localeOverrides: {} }),
    getRedirects: async () => ({ redirects: [] }),
    listPosts: async () => [],
};
const audits = [];
const make = () => createLinkHandlers({
    deps: { audit: async (...a) => { audits.push(a); } },
    cmsStore,
    resolveSite: async () => ({ siteId: 'pj_aaaa' }),
    takeBudget: createTakeBudget(() => 0),
}).handlers.cms_check_links;
const ctx = { userId: 'u1', orgId: 'o1', token: { name: 'tok' } };

test('the tool is read-only and takes siteId and external', () => {
    assert.equal(LINK_TOOLS[0].name, 'cms_check_links');
    assert.equal(LINK_TOOLS[0].readOnly, true);
    assert.deepEqual(Object.keys(LINK_TOOLS[0].parameters.properties), ['siteId', 'external']);
});

test('reports internal problems and audits counts only', async () => {
    const out = await make()({}, ctx);
    assert.equal(out.result.summary.errors, 1);
    assert.equal(audits.at(-1)[0], 'cms.links.check.mcp');
    assert.equal(audits.at(-1)[5].external, false);
    assert.ok(!JSON.stringify(audits.at(-1)).includes('http'));
});

test('unknown fields are refused; external runs are rate limited per user', async () => {
    const check = make();
    assert.match((await check({ nope: 1 }, ctx)).result.error, /Unknown field/);
    for (let i = 0; i < EXTERNAL_MAX_PER_WINDOW; i++) {
        const out = await check({ external: true }, ctx);
        assert.equal(out.result.error, undefined);
    }
    assert.match((await check({ external: true }, ctx)).result.error, /limited to/);
});

test('cms_publish returns the internal broken links in validation', async () => {
    const { createPublishHandlers } = require('./publishHandlers');
    const { publish } = createPublishHandlers({
        deps: { audit: async () => undefined },
        cmsStore: { ...cmsStore, publishSite: async () => ({ publishedAt: 'now' }) },
        live: { getLiveSiteId: async () => 'pj_aaaa' },
        resolveSite: async () => ({ siteId: 'pj_aaaa' }),
        loadDraft: async () => ({}),
        validationOf: () => null,
    });
    const out = await publish({}, ctx);
    assert.equal(out.result.published, true);
    assert.equal(out.result.validation.warnings[0].code, 'broken_link');
});
