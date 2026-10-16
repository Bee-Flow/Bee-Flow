/**
 * Locale overrides follow the ITEM, not the array index: reordering header
 * CTAs, nav items or block arrays in the default language must not move the
 * translations onto other items.
 *
 * Run: node --test stores/cmsStore.overrideAlign.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('./cmsStore.testkit');

const { configState } = installCmsStoreMocks();

const cmsStore = require('./cmsStore');
const { realign } = require('./cms/overrideAlign');
const realignOverride = (prev, next, ov, orphans = {}) => realign(prev, next, ov, orphans, 'x');

const SITE = 'pj_abcd1234';

test('realignOverride: id-keyed arrays follow the item, id-less primitives follow by value', () => {
    const prev = { ctas: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], tags: ['x', 'y'] };
    const next = { ctas: [{ id: 'b', label: 'B' }, { id: 'a', label: 'A' }], tags: ['y', 'x'] };
    const ov = { ctas: [{ label: 'A-nl' }, { label: 'B-nl' }], tags: ['x-nl', 'y-nl'] };
    const out = realignOverride(prev, next, ov);
    assert.deepStrictEqual(out.ctas, [{ label: 'B-nl' }, { label: 'A-nl' }]);
    assert.deepStrictEqual(out.tags, ['y-nl', 'x-nl']);
});

test('realignOverride: a new item gets no translation, a removed one is parked', () => {
    const prev = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const next = [{ id: 'new' }, { id: 'c' }, { id: 'a' }];
    const out = realignOverride(prev, next, [{ t: 'a' }, { t: 'b' }, { t: 'c' }]);
    assert.deepStrictEqual(out, [null, { t: 'c' }, { t: 'a' }]);
});

test('realignOverride: nested id arrays inside a moved item move with it', () => {
    const prev = [{ id: 'c1', items: [{ id: 'i1' }, { id: 'i2' }] }, { id: 'c2', items: [{ id: 'i3' }] }];
    const next = [{ id: 'c2', items: [{ id: 'i3' }] }, { id: 'c1', items: [{ id: 'i2' }, { id: 'i1' }] }];
    const ov = [{ items: [{ l: 'i1' }, { l: 'i2' }] }, { items: [{ l: 'i3' }] }];
    assert.deepStrictEqual(realignOverride(prev, next, ov),
        [{ items: [{ l: 'i3' }] }, { items: [{ l: 'i2' }, { l: 'i1' }] }]);
});

test('saving a site with reordered header CTAs re-keys the stored NL override', async () => {
    const ctaContact = { id: 'cta_contact', label: 'Contact', link: { kind: 'anchor', anchor: 'x' } };
    const ctaApp = { id: 'cta_app', label: 'App', link: { kind: 'anchor', anchor: 'y' } };
    const site = await cmsStore.createProject({ name: 'Synthetic' });
    const siteId = site.siteId || site.id;
    const base = await cmsStore.getProject(siteId, { fresh: true });
    await cmsStore.setProject(siteId, { ...base, header: { ...base.header, ctas: [ctaContact, ctaApp] } });
    await cmsStore.setSiteLocaleOverride(siteId, 'nl', {
        header: { ctas: [{ label: 'Neem contact op' }, { label: 'Open de app' }] },
    });

    const cur = await cmsStore.getProject(siteId, { fresh: true });
    await cmsStore.setProject(siteId, { ...cur, header: { ...cur.header, ctas: [ctaApp, ctaContact] } });

    const ov = await cmsStore.getSiteLocaleOverride(siteId, 'nl', { fresh: true });
    assert.deepStrictEqual(ov.header.ctas, [{ label: 'Open de app' }, { label: 'Neem contact op' }]);
});

test('saving a page with a reordered FAQ array re-keys the page override', async () => {
    const faq = (id) => ({ id, q: `q-${id}`, a: `a-${id}` });
    const block = (items) => ({ id: 'blk_faq', type: 'faq', enabled: true, content: { items }, style: {} });
    const page = (items) => ({ id: 'pg_1', slug: 'p', title: 'P', blocks: [block(items)] });
    await cmsStore.setPage(SITE, page([faq('one'), faq('two')]));
    await cmsStore.setPageLocaleOverride(SITE, 'pg_1', 'nl', {
        blocks: { blk_faq: { content: { items: [{ q: 'vraag-een' }, { q: 'vraag-twee' }] } } },
    });
    await cmsStore.setPage(SITE, page([faq('two'), faq('one')]));
    const ov = await cmsStore.getPageLocaleOverride(SITE, 'pg_1', 'nl', { fresh: true });
    assert.deepStrictEqual(ov.blocks.blk_faq.content.items, [{ q: 'vraag-twee' }, { q: 'vraag-een' }]);
    assert.ok(configState.map.size > 0);
});

test('realign: id-less items (FAQ entries) follow a pure reorder by content', () => {
    const faq = (q) => ({ q, a: `a-${q}` });
    const out = realignOverride([faq('1'), faq('2'), faq('3')], [faq('3'), faq('1'), faq('2')],
        [{ q: 'v1' }, { q: 'v2' }, { q: 'v3' }]);
    assert.deepStrictEqual(out, [{ q: 'v3' }, { q: 'v1' }, { q: 'v2' }]);
});

test('realign: an item re-created with a fresh id or edited in place keeps its translation (position)', () => {
    const out = realignOverride([{ id: 'nav_old1', label: 'A' }, { id: 'nav_old2', label: 'B' }],
        [{ id: 'nav_new1', label: 'A' }, { id: 'nav_new2', label: 'B2' }], [{ label: 'a-nl' }, { label: 'b-nl' }]);
    assert.deepStrictEqual(out, [{ label: 'a-nl' }, { label: 'b-nl' }]);
});

test('realign: a mixed array (some ids, some not) and duplicate ids are handled', () => {
    const out = realignOverride([{ id: 'a', t: 1 }, { t: 2 }, { id: 'c', t: 3 }], [{ id: 'c', t: 3 }, { t: 2 }, { id: 'a', t: 1 }],
        ['A', 'B', 'C']);
    assert.deepStrictEqual(out, ['C', 'B', 'A']);
    const dup = realignOverride([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'a' }, { id: 'b' }], ['A', 'B']);
    assert.strictEqual(dup.length, 3);
    assert.strictEqual(dup[0], 'A');
});

test('realign: the translation of a removed item is parked and revived when it comes back', () => {
    const orphans = {};
    const one = [{ id: 'a', t: 'a' }, { id: 'b', t: 'b' }, { id: 'c', t: 'c' }];
    const two = [{ id: 'a', t: 'a' }, { id: 'c', t: 'c' }];
    const removed = realignOverride(one, two, ['A', 'B', 'C'], orphans);
    assert.deepStrictEqual(removed, ['A', 'C']);
    assert.deepStrictEqual(Object.values(orphans), ['B']);
    const undone = realignOverride(two, one, removed, orphans);
    assert.deepStrictEqual(undone, ['A', 'B', 'C']);
    assert.deepStrictEqual(orphans, {});
});

test('a failed re-key leaves neither the content nor the overrides changed (one transaction)', async () => {
    const faq = (id) => ({ id, q: `q-${id}` });
    const page = (items) => ({ id: 'pg_atomic', slug: 'p', title: 'P', blocks: [{ id: 'blk_a', type: 'faq', enabled: true, content: { items }, style: {} }] });
    await cmsStore.setPage(SITE, page([faq('x'), faq('y')]));
    await cmsStore.setPageLocaleOverride(SITE, 'pg_atomic', 'nl', { blocks: { blk_a: { content: { items: [{ q: 'ex' }, { q: 'ye' }] } } } });
    const before = JSON.stringify([...configState.map.entries()]);
    // A corrupt override row makes the re-key throw halfway.
    configState.map.set(`cms_project_${SITE}_page_pg_atomic_locale_zz`, { blocks: { blk_a: { content: { get items() { throw new Error('boom'); } } } } });
    const poisoned = JSON.stringify([...configState.map.entries()].filter(([k]) => !k.endsWith('_zz')));
    await assert.rejects(() => cmsStore.setPage(SITE, page([faq('y'), faq('x')])));
    configState.map.delete(`cms_project_${SITE}_page_pg_atomic_locale_zz`);
    assert.strictEqual(JSON.stringify([...configState.map.entries()]), before);
    assert.strictEqual(poisoned, before);
    // A retry now re-keys against the still-old stored order.
    await cmsStore.setPage(SITE, page([faq('y'), faq('x')]));
    const ov = await cmsStore.getPageLocaleOverride(SITE, 'pg_atomic', 'nl', { fresh: true });
    assert.deepStrictEqual(ov.blocks.blk_a.content.items, [{ q: 'ye' }, { q: 'ex' }]);
});

test('setPage and the site save hand the re-aligned overrides back to the caller', async () => {
    const faq = (id) => ({ id, q: id });
    const page = (items) => ({ id: 'pg_ret', slug: 'r', title: 'R', blocks: [{ id: 'blk_r', type: 'faq', enabled: true, content: { items }, style: {} }] });
    await cmsStore.setPage(SITE, page([faq('p'), faq('q')]));
    await cmsStore.setPageLocaleOverride(SITE, 'pg_ret', 'nl', { blocks: { blk_r: { content: { items: [{ q: 'pe' }, { q: 'qe' }] } } } });
    const { localeOverrides } = await cmsStore.setPage(SITE, page([faq('q'), faq('p')]));
    assert.deepStrictEqual(localeOverrides.nl.blocks.blk_r.content.items, [{ q: 'qe' }, { q: 'pe' }]);
    const none = await cmsStore.setPage(SITE, page([faq('q'), faq('p')]));
    assert.deepStrictEqual(none.localeOverrides, {});
});

test('deleting a page keeps the remaining header translations on their own items', async () => {
    const project = await cmsStore.createProject({ name: 'Synthetic' });
    const siteId = project.siteId || project.id;
    const created = await cmsStore.createPage(siteId, { slug: 'about', title: 'About' });
    const pageId = created.page?.id || created.id || created.pageId;
    const base = await cmsStore.getProject(siteId, { fresh: true });
    const nav = [
        { id: 'nav_a', label: 'About', link: { kind: 'page', pageId } },
        { id: 'nav_b', label: 'Blog', link: { kind: 'anchor', anchor: 'b' } },
    ];
    await cmsStore.setProject(siteId, { ...base, header: { ...base.header, nav } });
    await cmsStore.setSiteLocaleOverride(siteId, 'nl', { header: { nav: [{ label: 'Over ons' }, { label: 'Blog-NL' }] } });
    await cmsStore.removePage(siteId, pageId);
    const after = await cmsStore.getProject(siteId, { fresh: true });
    assert.deepStrictEqual(after.header.nav.map((n) => n.label), ['Blog']);
    const ov = await cmsStore.getSiteLocaleOverride(siteId, 'nl', { fresh: true });
    assert.deepStrictEqual(ov.header.nav[0], { label: 'Blog-NL' });
});

test('an AI translation computed before a reorder is re-aligned when it is saved, keeping parked translations', async () => {
    const faq = (id) => ({ id, q: id });
    const page = (items) => ({ id: 'pg_ai', slug: 'ai', title: 'AI', blocks: [{ id: 'blk_ai', type: 'faq', enabled: true, content: { items }, style: {} }] });
    const snapshot = (await cmsStore.setPage(SITE, page([faq('m'), faq('n')]))).page;
    await cmsStore.setPageLocaleOverride(SITE, 'pg_ai', 'nl', {
        blocks: { blk_ai: { content: { items: [{ q: 'em' }] }, _orphans: { 'content.items#id:old': { q: 'oud' } } } },
    });
    // The editor reorders while the model works on `snapshot`.
    await cmsStore.setPage(SITE, page([faq('n'), faq('m')]));
    const result = { version: 1, blocks: { blk_ai: { content: { items: [{ q: 'em-ai' }, { q: 'en-ai' }] } } } };
    const saved = await cmsStore.saveTranslatedPageOverride(SITE, 'pg_ai', 'nl', result, snapshot);
    assert.deepStrictEqual(saved.blocks.blk_ai.content.items, [{ q: 'en-ai' }, { q: 'em-ai' }]);
    assert.deepStrictEqual(Object.values(saved.blocks.blk_ai._orphans || {}).length > 0, true, 'parked translations kept');
});

test('pruning a block runs under the page lock and leaves other blocks alone', async () => {
    const block = (id) => ({ id, type: 'content', enabled: true, content: { title: id }, style: {} });
    await cmsStore.setPage(SITE, { id: 'pg_pr', slug: 'pr', title: 'P', blocks: [block('b1'), block('b2')] });
    await cmsStore.setPageLocaleOverride(SITE, 'pg_pr', 'nl', { blocks: { b1: { content: { title: 'een' } }, b2: { content: { title: 'twee' } } } });
    assert.deepStrictEqual(await cmsStore.pruneBlockLocaleOverrides(SITE, 'pg_pr', 'b1'), ['nl']);
    const ov = await cmsStore.getPageLocaleOverride(SITE, 'pg_pr', 'nl', { fresh: true });
    assert.deepStrictEqual(Object.keys(ov.blocks), ['b2']);
});

test('a client-supplied _orphans bag is capped', async () => {
    const bag = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, { t: i }]));
    const project = await cmsStore.createProject({ name: 'Synthetic' });
    const siteId = project.siteId || project.id;
    await cmsStore.setSiteLocaleOverride(siteId, 'nl', { header: {}, _orphans: bag });
    const ov = await cmsStore.getSiteLocaleOverride(siteId, 'nl', { fresh: true });
    assert.strictEqual(Object.keys(ov._orphans).length, 100);
});
