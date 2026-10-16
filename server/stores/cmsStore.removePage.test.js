// @typecheck
/**
 * Deleting a page: links to it elsewhere on the site are neutralised, the
 * outcome says what happened, and nothing of it is left behind.
 *
 * Run: node --test stores/cmsStore.removePage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('./cmsStore.testkit');

installCmsStoreMocks();

const cmsStore = require('./cmsStore');

/** A site with home, about, contact; home and contact link to about. */
async function buildSite() {
    const { id: siteId } = await cmsStore.createProject({ name: 'Site' });
    const site = await cmsStore.getProject(siteId);
    const homeId = site.pages[0].id;
    const { id: aboutId } = await cmsStore.createPage(siteId, { slug: 'about', title: 'About' });
    const { id: contactId } = await cmsStore.createPage(siteId, { slug: 'contact', title: 'Contact' });

    const home = await cmsStore.getPage(siteId, homeId);
    const hero = cmsStore.makeBlock('hero');
    hero.content.cta = { label: 'More', link: { kind: 'page', pageId: aboutId } };
    home.blocks = [hero];
    await cmsStore.setPage(siteId, home);

    const contact = await cmsStore.getPage(siteId, contactId);
    const content = cmsStore.makeBlock('content');
    content.content.extra = { items: [{ title: 'A', link: { kind: 'page', pageId: aboutId } }] };
    contact.blocks = [content];
    await cmsStore.setPage(siteId, contact);

    await cmsStore.setSiteLocaleOverride(siteId, 'nl', { pageTitles: { [aboutId]: 'Over ons', [contactId]: 'Contact' } });
    return { siteId, homeId, aboutId, contactId };
}

test('removePage neutralises links to the page inside other pages and reports the count', async () => {
    const { siteId, homeId, aboutId, contactId } = await buildSite();
    const outcome = await cmsStore.removePage(siteId, aboutId);

    assert.deepStrictEqual(outcome.removed, { id: aboutId, slug: 'about' });
    assert.strictEqual(outcome.neutralisedLinks, 2);
    assert.strictEqual(outcome.newHomepage, null);

    const home = await cmsStore.getPage(siteId, homeId);
    assert.deepStrictEqual(home.blocks[0].content.cta.link, { kind: 'anchor', anchor: '' });
    const contact = await cmsStore.getPage(siteId, contactId);
    assert.deepStrictEqual(contact.blocks[0].content.extra.items[0].link, { kind: 'anchor', anchor: '' });
    assert.strictEqual(contact.blocks[0].content.extra.items.length, 1, 'the item itself stays');
});

test('removePage prunes the deleted page from the site-level page titles', async () => {
    const { siteId, aboutId, contactId } = await buildSite();
    await cmsStore.removePage(siteId, aboutId);
    const ov = await cmsStore.getSiteLocaleOverride(siteId, 'nl');
    assert.deepStrictEqual(ov.pageTitles, { [contactId]: 'Contact' });
});

test('removePage names the page that became the homepage', async () => {
    const { siteId, homeId, aboutId } = await buildSite();
    const outcome = await cmsStore.removePage(siteId, homeId);
    assert.deepStrictEqual(outcome.newHomepage, { id: aboutId, slug: 'about' });
});

test('removePage on an unknown page id changes nothing and returns null', async () => {
    const { siteId } = await buildSite();
    assert.strictEqual(await cmsStore.removePage(siteId, 'pg_unknown'), null);
    assert.strictEqual((await cmsStore.getProject(siteId)).pages.length, 3);
});
