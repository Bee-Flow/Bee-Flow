// @typecheck
/**
 * mergePageLocaleOverride: update one block's translation of a page without
 * resending the rest of the override (an MCP client cannot send a 90k-character
 * override in one tool argument).
 *
 * Run: node --test stores/cms/localeOverrides.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('../cmsStore.testkit');

installCmsStoreMocks();

const cmsStore = require('../cmsStore');

const SITE = 'pj_abcd5678';
const PAGE = 'pg_merge';

async function seed() {
    const block = (id) => ({ id, type: 'faq', enabled: true, content: { items: [] }, style: {} });
    await cmsStore.setPage(SITE, { id: PAGE, slug: 'merge', title: 'Merge', blocks: [block('blk_a'), block('blk_b'), block('blk_c')] });
    await cmsStore.setPageLocaleOverride(SITE, PAGE, 'nl', {
        blocks: {
            blk_a: { content: { title: 'A-nl', body: 'lang verhaal' } },
            blk_b: { content: { title: 'B-nl', items: [{ q: 'vraag' }] } },
        },
        seo: { metaTitle: 'Titel', metaDescription: 'Beschrijving' },
    });
}

test('merge keeps the blocks it is not given and replaces the named block whole', async () => {
    await seed();
    await cmsStore.mergePageLocaleOverride(SITE, PAGE, 'nl', { blocks: { blk_b: { content: { title: 'B-nieuw' } } } });
    const ov = await cmsStore.getPageLocaleOverride(SITE, PAGE, 'nl', { fresh: true });
    assert.deepStrictEqual(ov.blocks.blk_a, { content: { title: 'A-nl', body: 'lang verhaal' } });
    // No deep merge inside a block: the old `items` is gone.
    assert.deepStrictEqual(ov.blocks.blk_b, { content: { title: 'B-nieuw' } });
    assert.deepStrictEqual(ov.seo, { metaTitle: 'Titel', metaDescription: 'Beschrijving' });
});

test('merge adds a block that had no translation yet', async () => {
    await seed();
    await cmsStore.mergePageLocaleOverride(SITE, PAGE, 'nl', { blocks: { blk_c: { content: { title: 'C-nl' } } } });
    const ov = await cmsStore.getPageLocaleOverride(SITE, PAGE, 'nl', { fresh: true });
    assert.deepStrictEqual(Object.keys(ov.blocks).sort(), ['blk_a', 'blk_b', 'blk_c']);
});

test('merge replaces seo only when it is given', async () => {
    await seed();
    await cmsStore.mergePageLocaleOverride(SITE, PAGE, 'nl', { seo: { metaTitle: 'Nieuw' } });
    const ov = await cmsStore.getPageLocaleOverride(SITE, PAGE, 'nl', { fresh: true });
    assert.deepStrictEqual(ov.seo, { metaTitle: 'Nieuw' });
    assert.deepStrictEqual(ov.blocks.blk_a, { content: { title: 'A-nl', body: 'lang verhaal' } });
});

test('merge onto a language without an override starts from an empty one', async () => {
    await seed();
    await cmsStore.mergePageLocaleOverride(SITE, PAGE, 'de', { blocks: { blk_a: { content: { title: 'A-de' } } } });
    const ov = await cmsStore.getPageLocaleOverride(SITE, PAGE, 'de', { fresh: true });
    assert.deepStrictEqual(ov.blocks, { blk_a: { content: { title: 'A-de' } } });
    assert.equal(ov.seo, undefined);
});

test('merge rejects a block id that is not on the page and writes nothing', async () => {
    await seed();
    await assert.rejects(
        cmsStore.mergePageLocaleOverride(SITE, PAGE, 'nl', { blocks: { blk_a: { content: { title: 'x' } }, blk_zzz: { content: { title: 'y' } } } }),
        (e) => /** @type {any} */ (e).code === 'UNKNOWN_BLOCK' && /** @type {any} */ (e).blockIds.includes('blk_zzz'),
    );
    const ov = await cmsStore.getPageLocaleOverride(SITE, PAGE, 'nl', { fresh: true });
    assert.equal(ov.blocks.blk_a.content.title, 'A-nl');
});

test('merge sanitises the merged result: an illegal media address is dropped', async () => {
    await seed();
    await cmsStore.mergePageLocaleOverride(SITE, PAGE, 'nl', { blocks: { blk_c: { content: { media: { src: 'javascript:alert(1)', poster: 'cms/p.jpg' } } } } });
    const ov = await cmsStore.getPageLocaleOverride(SITE, PAGE, 'nl', { fresh: true });
    assert.equal(ov.blocks.blk_c.content.media.src, undefined);
    assert.equal(ov.blocks.blk_c.content.media.poster, 'cms/p.jpg');
});

test('setPageLocaleOverride (no merge) still replaces the whole override', async () => {
    await seed();
    await cmsStore.setPageLocaleOverride(SITE, PAGE, 'nl', { blocks: { blk_b: { content: { title: 'alleen B' } } } });
    const ov = await cmsStore.getPageLocaleOverride(SITE, PAGE, 'nl', { fresh: true });
    assert.deepStrictEqual(Object.keys(ov.blocks), ['blk_b']);
    assert.equal(ov.seo, undefined);
});
