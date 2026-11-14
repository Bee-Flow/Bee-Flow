/**
 * Links follow the language of the page they sit on.
 *
 * A Dutch page used to link to the English page: a link to the Contact page
 * resolved to '/contact' whatever the page language, so a visitor reading
 * /nl/offerte-intake who clicked "Plan een procesgesprek" left the Dutch site,
 * and a link shared from it was English. Now a link on a Dutch page resolves
 * to the Dutch path. Only paths to this site's own pages move; app routes,
 * mail addresses and outside URLs stay exactly as written.
 *
 * Run: node --test stores/cms/effective.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

// The default language is a database setting; pin it before effective.js
// takes its reference, so the resolve tests need no database.
const localeOverrides = require('./localeOverrides');
localeOverrides.getDefaultLocale = async () => 'en';

const {
    resolveLink, resolveLinksInTree, localePathPrefix, localizePath, resolveEffective,
} = require('./effective');

const PAGES = [
    { id: 'pg_home', slug: 'home', title: 'Home', isHomepage: true },
    { id: 'pg_contact', slug: 'contact', title: 'Contact' },
    { id: 'pg_quote', slug: 'offerte-intake', title: 'Quote intake' },
];

test('the default language has no prefix; nl has /nl, also for a regional tag', () => {
    assert.strictEqual(localePathPrefix('en', 'en'), '');
    assert.strictEqual(localePathPrefix('nl', 'en'), '/nl');
    assert.strictEqual(localePathPrefix('nl-be', 'en'), '/nl');
    // A language the router does not prefix is served at the plain path.
    assert.strictEqual(localePathPrefix('de', 'en'), '');
});

test('a page link resolves into the page language', () => {
    assert.deepStrictEqual(resolveLink({ kind: 'page', pageId: 'pg_contact' }, PAGES, '/nl'), { href: '/nl/contact' });
    assert.deepStrictEqual(resolveLink({ kind: 'page', pageId: 'pg_home' }, PAGES, '/nl'), { href: '/nl' });
    assert.deepStrictEqual(
        resolveLink({ kind: 'page', pageId: 'pg_contact', anchor: 'form' }, PAGES, '/nl'),
        { href: '/nl/contact#form' },
    );
});

test('without a prefix nothing changes', () => {
    assert.deepStrictEqual(resolveLink({ kind: 'page', pageId: 'pg_contact' }, PAGES), { href: '/contact' });
    assert.deepStrictEqual(resolveLink({ kind: 'page', pageId: 'pg_home' }, PAGES, ''), { href: '/' });
    assert.deepStrictEqual(resolveLink({ kind: 'external', url: '/contact' }, PAGES), { href: '/contact' });
});

test('a relative link to a page of the site moves; everything else stays', () => {
    assert.strictEqual(localizePath('/contact', '/nl', PAGES), '/nl/contact');
    assert.strictEqual(localizePath('/', '/nl', PAGES), '/nl');
    assert.strictEqual(localizePath('/offerte-intake?utm_source=x#voorbeeld', '/nl', PAGES), '/nl/offerte-intake?utm_source=x#voorbeeld');
    // Already in the page language: left alone, never doubled.
    assert.strictEqual(localizePath('/nl/contact', '/nl', PAGES), '/nl/contact');
    // Not a page of this site.
    assert.strictEqual(localizePath('/app', '/nl', PAGES), '/app');
    assert.strictEqual(localizePath('/api/cms/asset/x.png', '/nl', PAGES), '/api/cms/asset/x.png');
    assert.strictEqual(localizePath('/unknown', '/nl', PAGES), '/unknown');
    // Not a site path at all.
    assert.strictEqual(localizePath('https://github.com/Bee-Flow', '/nl', PAGES), 'https://github.com/Bee-Flow');
    assert.strictEqual(localizePath('mailto:info@beeflow.nl?subject=x', '/nl', PAGES), 'mailto:info@beeflow.nl?subject=x');
    assert.strictEqual(localizePath('//cdn.example.com/x', '/nl', PAGES), '//cdn.example.com/x');
    assert.strictEqual(localizePath('#tabs', '/nl', PAGES), '#tabs');
});

test('a relative link to the blog follows the page language too', () => {
    // The menu and footer store "Blog" as { kind: 'external', url: '/blog' }: the blog is
    // a built-in route, not a page, so it was left in English on every Dutch page.
    assert.strictEqual(localizePath('/blog', '/nl', PAGES), '/nl/blog');
    assert.strictEqual(localizePath('/blog/', '/nl', PAGES), '/nl/blog/');
    assert.strictEqual(localizePath('/blog/customer-data-in-ai-chat', '/nl', PAGES), '/nl/blog/customer-data-in-ai-chat');
    assert.strictEqual(localizePath('/blog?tag=privacy#list', '/nl', PAGES), '/nl/blog?tag=privacy#list');
    assert.strictEqual(localizePath('/blog/feed.xml', '/nl', PAGES), '/nl/blog/feed.xml');
    assert.strictEqual(localizePath('/nl/blog', '/nl', PAGES), '/nl/blog');
    assert.strictEqual(localizePath('/blog', '', PAGES), '/blog');
    // Deeper than the blog's own routes, or merely starting with the letters: not the blog.
    assert.strictEqual(localizePath('/blog/a/b', '/nl', PAGES), '/blog/a/b');
    assert.strictEqual(localizePath('/blogs', '/nl', PAGES), '/blogs');
    assert.strictEqual(localizePath('https://example.com/blog', '/nl', PAGES), 'https://example.com/blog');
    assert.deepStrictEqual(resolveLink({ kind: 'external', url: '/blog' }, PAGES, '/nl'), { href: '/nl/blog' });
});

test('external, app and anchor links keep their target and attributes', () => {
    assert.deepStrictEqual(
        resolveLink({ kind: 'external', url: 'https://github.com/Bee-Flow', newTab: true }, PAGES, '/nl'),
        { href: 'https://github.com/Bee-Flow', target: '_blank', rel: 'noopener noreferrer' },
    );
    assert.deepStrictEqual(resolveLink({ kind: 'external', url: '/contact' }, PAGES, '/nl'), { href: '/nl/contact' });
    assert.deepStrictEqual(resolveLink({ kind: 'app', path: '/app' }, PAGES, '/nl'), { href: '/app' });
    assert.deepStrictEqual(resolveLink({ kind: 'anchor', anchor: 'tabs' }, PAGES, '/nl'), { href: '#tabs' });
});

test('a card link stored as a bare path follows too', () => {
    const tree = { items: [{ title: 'A', cardUrl: '/offerte-intake' }, { title: 'B', cardUrl: '/app' }], cta: { kind: 'page', pageId: 'pg_contact' } };
    assert.deepStrictEqual(resolveLinksInTree(tree, PAGES, '/nl'), {
        items: [{ title: 'A', cardUrl: '/nl/offerte-intake' }, { title: 'B', cardUrl: '/app' }],
        cta: { href: '/nl/contact' },
    });
});

function ctx() {
    const site = {
        homepageId: 'pg_home',
        pages: PAGES,
        header: {
            logo: { url: '/' },
            ctas: [{ id: 'cta_demo', label: 'Plan a call', link: { kind: 'page', pageId: 'pg_contact' } }],
            nav: [{ id: 'nav_1', label: 'Solutions', link: { kind: 'page', pageId: 'pg_quote' } }],
        },
        footer: { columns: [{ id: 'c', heading: 'Company', links: [{ label: 'Contact', link: { kind: 'external', url: '/contact' } }] }] },
    };
    const page = { id: 'pg_quote', title: 'Quote intake', seo: {}, blocks: [
        { id: 'blk_cta', type: 'cta', enabled: true, content: { button: { label: 'Plan a call', link: { kind: 'page', pageId: 'pg_contact' } } } },
    ] };
    return {
        getSite: async () => site,
        getPage: async () => page,
        getSiteLocaleOverride: async () => null,
        getPageLocaleOverride: async () => null,
    };
}

test('a Dutch page links into Dutch everywhere: header, logo, footer and blocks', async () => {
    const r = await resolveEffective('pj_test', 'offerte-intake', 'nl', ctx());
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.header.logo.url, '/nl');
    assert.strictEqual(r.header.ctas[0].link.href, '/nl/contact');
    assert.strictEqual(r.header.nav[0].link.href, '/nl/offerte-intake');
    assert.strictEqual(r.footer.columns[0].links[0].link.href, '/nl/contact');
    assert.strictEqual(r.page.blocks[0].content.button.link.href, '/nl/contact');
});

test('the default language keeps the plain paths', async () => {
    const r = await resolveEffective('pj_test', 'offerte-intake', 'en', ctx());
    assert.strictEqual(r.header.logo.url, '/');
    assert.strictEqual(r.header.ctas[0].link.href, '/contact');
    assert.strictEqual(r.page.blocks[0].content.button.link.href, '/contact');
});
