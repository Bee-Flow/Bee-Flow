/**
 * GET /api/cms/stories — the public read behind the Customer stories grid.
 * Anonymous, published content only, query values clamped, never an error
 * page (a refusal would blank a block on a public page).
 *
 * Run: node --test routes/cmsStories.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const h = require('../testUtils/routeHarness');

const { configTableAnswer } = require('../stores/cmsStore.testkit');

const configState = { map: new Map() };
const { api } = h.routeUnderTest(test, '/api/cms/stories', () => require('./cmsStories').createPublicRouter(), {
    answer: configTableAnswer(configState),
});

const get = (qs = '') => api.call('GET', `/api/cms/stories${qs}`);

test('without a live site the answer is an empty list, not an error', async () => {
    const res = await get();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { stories: [] });
    assert.match(res.headers.get('cache-control') || '', /public/);
});

test('it answers the published stories of the live site and clamps nonsense queries', async () => {
    const cmsStore = require('../stores/cmsStore');
    const { setLiveSiteId } = require('./cmsShared');
    const { id: siteId } = await cmsStore.createProject({ name: 'Live' });
    const created = await cmsStore.createPage(siteId, { title: 'Story one' });
    const page = await cmsStore.getPage(siteId, created.id);
    await cmsStore.setPage(siteId, {
        ...page,
        blocks: [{ id: 'blk_story', type: 'story-header', enabled: true, style: {}, content: { customer: 'Acme Test Co', sector: 'Finance', title: 'Acme story' } }],
    });
    await cmsStore.publishSite(siteId);
    await setLiveSiteId(siteId);

    const res = await get('?limit=banana&locale=%3Cscript%3E&sector=' + 'x'.repeat(500));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.stories, [], 'an unknown sector filters everything out');

    const ok = await get('?limit=1&sector=finance');
    assert.strictEqual(ok.body.stories.length, 1);
    assert.strictEqual(ok.body.stories[0].customer, 'Acme Test Co');
    assert.strictEqual(ok.body.stories[0].href, '/story-one');
    assert.ok(!('content' in ok.body.stories[0]), 'cards are an allow-list, not the block');
});
