/**
 * #229: an override saved under a regional tag (pt-br) must be found when that
 * tag is requested, and a request for a regional tag must fall back to the base
 * language override, instead of collapsing every locale to its first subtag.
 *
 * Run: node --test stores/cmsStore.localeTags.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('./cmsStore.testkit');

installCmsStoreMocks();

const cmsStore = require('./cmsStore');

async function seed() {
    const project = await cmsStore.createProject({ name: 'Synthetic' });
    const siteId = project.siteId || project.id;
    const site = await cmsStore.getProject(siteId, { fresh: true });
    const pageId = site.pages[0].id;
    const slug = site.pages[0].slug;
    await cmsStore.setPage(siteId, {
        id: pageId, slug, title: 'Home',
        blocks: [{ id: 'blk_h', type: 'content', enabled: true, content: { title: 'Hello' }, style: {} }],
    });
    return { siteId, pageId, slug };
}

const titleOf = (eff) => eff.page.blocks.find((b) => b.id === 'blk_h').content.title;

test('a regional-tag override is served for the regional tag', async () => {
    const { siteId, pageId, slug } = await seed();
    await cmsStore.setPageLocaleOverride(siteId, pageId, 'pt-br', { blocks: { blk_h: { content: { title: 'Ola Brasil' } } } });
    const eff = await cmsStore.getEffective(siteId, slug, 'pt-BR');
    assert.strictEqual(titleOf(eff), 'Ola Brasil');
});

test('a regional request falls back to the base-language override', async () => {
    const { siteId, pageId, slug } = await seed();
    await cmsStore.setPageLocaleOverride(siteId, pageId, 'pt', { blocks: { blk_h: { content: { title: 'Ola' } } } });
    assert.strictEqual(titleOf(await cmsStore.getEffective(siteId, slug, 'pt-br')), 'Ola');
});

test('the exact tag wins over the base language', async () => {
    const { siteId, pageId, slug } = await seed();
    await cmsStore.setPageLocaleOverride(siteId, pageId, 'pt', { blocks: { blk_h: { content: { title: 'Ola' } } } });
    await cmsStore.setPageLocaleOverride(siteId, pageId, 'pt-br', { blocks: { blk_h: { content: { title: 'Ola Brasil' } } } });
    assert.strictEqual(titleOf(await cmsStore.getEffective(siteId, slug, 'pt-br')), 'Ola Brasil');
    assert.strictEqual(titleOf(await cmsStore.getEffective(siteId, slug, 'pt')), 'Ola');
});
