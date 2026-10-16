// @typecheck
/**
 * One slug rule for the CMS (validation) and the public router: whatever the
 * store accepts as a page slug, parsePublicPath must reach.
 *
 * Run: node --test stores/cms/slugRules.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('../cmsStore.testkit');

installCmsStoreMocks();

const cmsStore = require('../cmsStore');
const { parsePublicPath } = require('../../core/seo/publicPath');
const { normalizeSlug, slugProblem, RESERVED_PAGE_SLUGS, SLUG_MAX_LENGTH } = require('./slugRules');

const LOCALES = ['en', 'nl'];

test('every normalised slug that is not reserved is reachable through the public router', () => {
    const inputs = [
        'about_us', '-lead', 'trail-', '  Spaced Out  ', '/Leading/slash', 'UPPER', 'a__b--c',
        'ünïcode', 'x'.repeat(200), '!!!', '9lives', 'about us/team',
    ];
    for (const raw of inputs) {
        const slug = normalizeSlug(raw);
        if (!slug || RESERVED_PAGE_SLUGS.has(slug)) continue;
        assert.deepStrictEqual(parsePublicPath(`/${slug}`, LOCALES), { locale: null, slug },
            `"${raw}" normalised to "${slug}", which the router does not reach`);
        assert.ok(slug.length <= SLUG_MAX_LENGTH);
    }
});

test('normalizeSlug turns underscores into dashes and trims dashes', () => {
    assert.strictEqual(normalizeSlug('about_us'), 'about-us');
    assert.strictEqual(normalizeSlug('-lead'), 'lead');
    assert.strictEqual(normalizeSlug('a  b__c'), 'a-b-c');
});

test('the reserved list covers locale prefixes and the blog, and not the released legal slugs', () => {
    for (const s of ['nl', 'blog', 'app', 'f']) assert.ok(RESERVED_PAGE_SLUGS.has(s), s);
    for (const s of ['terms', 'legal', 'privacy', 'pricing']) assert.ok(!RESERVED_PAGE_SLUGS.has(s), s);
});

test('slugProblem names why a stored slug cannot be served', () => {
    assert.strictEqual(slugProblem('about-us'), null);
    assert.strictEqual(slugProblem('about_us')?.code, 'unroutable');
    assert.strictEqual(slugProblem('nl')?.code, 'reserved');
    assert.strictEqual(slugProblem('x'.repeat(SLUG_MAX_LENGTH + 1))?.code, 'unroutable');
});

test('createPage and updatePageMeta refuse a locale prefix and accept terms', async () => {
    const { id: siteId } = await cmsStore.createProject({ name: 'Site' });
    await assert.rejects(cmsStore.createPage(siteId, { slug: 'nl', title: 'Dutch' }), /reserved/);
    const { slug } = await cmsStore.createPage(siteId, { slug: 'terms', title: 'Terms' });
    assert.strictEqual(slug, 'terms');
    const privacy = await cmsStore.createPage(siteId, { slug: 'privacy', title: 'Privacy' });
    assert.strictEqual(privacy.slug, 'privacy');
    const made = await cmsStore.createPage(siteId, { slug: 'about_us', title: 'About' });
    assert.strictEqual(made.slug, 'about-us');
    await assert.rejects(cmsStore.updatePageMeta(siteId, made.id, { slug: 'nl' }), /reserved/);
});

test('an imported page with a reserved slug is renamed and reported, not left unreachable', async () => {
    const { id: siteId } = await cmsStore.createProject({ name: 'Src' });
    /** @type {any} */
    const bundle = await cmsStore.exportSite(siteId);
    bundle.site.pages[0].slug = 'home';
    bundle.site.pages.push({ slug: 'nl', title: 'Dutch', blocks: [] });
    const result = await cmsStore.importSite(bundle);
    const site = await cmsStore.getProject(result.siteId);
    assert.ok(site.pages.every(p => !RESERVED_PAGE_SLUGS.has(p.slug)), JSON.stringify(site.pages.map(p => p.slug)));
    assert.ok(result.warnings.some(w => /nl/.test(w)), JSON.stringify(result.warnings));
});
