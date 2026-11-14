/**
 * The server-rendered blog: head (canonical, Open Graph article, BlogPosting
 * JSON-LD, RSS alternate), body markup, the RSS feed, sitemap entries, and
 * the blog paths of the routing rule (with the client copy pinned against it).
 *
 * Run: node --test core/seo/blog.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildBlogHead, renderBlogBody, buildFeed, blogSitemapEntries, feedPath, indexQuery } = require('./blog');
const { parsePublicPath, buildPublicPath } = require('./publicPath');
const { buildSitemap } = require('./sitemap');

const ORIGIN = 'https://site.test';
const labels = { title: 'Blog', by: 'By {name}', min_read: '{n} min read', back_to_blog: 'Back', older: 'Older', newer: 'Newer', tagged: 'Tagged {tag}', no_posts: 'None', home: 'Home' };

function postEff(overrides = {}) {
    const post = {
        id: 'po_1', slug: 'hello-world', title: 'Hello </script><script>alert(1)</script> world', excerpt: 'An "excerpt" & more',
        body: '## Part\n\nText <b>raw</b> [x](javascript:alert(1))', coverImage: 'cms/1700-cover.jpg', coverAlt: 'Cover',
        authorName: 'Ann Writer', tags: [{ slug: 'product', label: 'Product' }], publishedAt: '2026-10-01T09:00:00.000Z',
        updatedAt: '2026-10-02T09:00:00.000Z', readingMinutes: 3, seo: {}, ...overrides,
    };
    return {
        design: {},
        page: { slug: `blog/${post.slug}`, title: post.title, seo: { metaTitle: '', metaDescription: post.excerpt, ogImage: post.coverImage, noIndex: false }, blocks: [] },
        blog: { view: 'post', locale: 'en', defaultLocale: 'en', basePath: '/blog', title: 'Blog', description: '', labels, post, locales: ['en', 'nl'] },
    };
}

test('post head: canonical, article tags, BlogPosting JSON-LD that cannot break out of its script', () => {
    const head = buildBlogHead({ origin: ORIGIN, eff: postEff(), locale: 'en', defaultLocale: 'en', locales: ['en', 'nl'], siteName: 'Acme' });
    assert.match(head, /<link rel="canonical" href="https:\/\/site.test\/blog\/hello-world">/);
    assert.match(head, /<meta property="og:type" content="article">/);
    assert.match(head, /article:published_time" content="2026-10-01T09:00:00.000Z"/);
    assert.match(head, /hreflang="nl" href="https:\/\/site.test\/nl\/blog\/hello-world"/);
    assert.match(head, /type="application\/rss\+xml"[^>]*href="https:\/\/site.test\/blog\/feed.xml"/);
    assert.ok(!head.includes('</script><script>alert'), 'a title can never close the JSON-LD script');
    const ld = JSON.parse(head.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1]);
    const posting = ld['@graph'].find(n => n['@type'] === 'BlogPosting');
    assert.strictEqual(posting.author.name, 'Ann Writer');
    assert.strictEqual(posting.datePublished, '2026-10-01T09:00:00.000Z');
    assert.strictEqual(posting.image, 'https://site.test/api/cms/asset/cms/1700-cover.jpg');
    const crumbs = ld['@graph'].find(n => n['@type'] === 'BreadcrumbList');
    assert.deepStrictEqual(crumbs.itemListElement.map(c => c.item), ['https://site.test/', 'https://site.test/blog', 'https://site.test/blog/hello-world']);
});

test('post body: escaped text, sanitized Markdown, one h1', () => {
    const html = renderBlogBody(postEff());
    assert.strictEqual((html.match(/<h1>/g) || []).length, 1);
    assert.ok(!/<script|<b>raw|javascript:/i.test(html), html);
    assert.match(html, /<h2 id="part">Part<\/h2>/, 'a ## section is the h2 under the title h1');
    assert.match(html, /By Ann Writer · 3 min read/);
    assert.match(html, /href="\/blog\?tag=product">#Product/);
});

test('index body and head: list, paging links, Blog JSON-LD', () => {
    const eff = {
        design: {},
        page: { slug: 'blog', title: 'Blog', seo: { metaDescription: 'News', noIndex: false }, blocks: [] },
        blog: {
            view: 'index', locale: 'en', defaultLocale: 'en', basePath: '/blog', title: 'Blog', description: 'News', labels,
            posts: [{ slug: 'a-post', title: 'A <post>', excerpt: 'x', tags: [], publishedAt: '2026-10-01T00:00:00Z', readingMinutes: 1 }],
            page: 2, pageCount: 3, total: 21, tag: { slug: 'product', label: 'Product' }, tags: [{ slug: 'product', label: 'Product' }, { slug: 'x', label: 'R&D' }],
        },
    };
    const html = renderBlogBody(eff);
    assert.match(html, /<nav aria-label="Tags"><a href="\/blog">All posts<\/a> · <a href="\/blog\?tag=product" aria-current="page">Product<\/a> · <a href="\/blog\?tag=x">R&amp;D<\/a><\/nav>/);
    assert.match(html, /<h1>Tagged Product<\/h1>/);
    assert.match(html, /<a href="\/blog\/a-post">A &lt;post&gt;<\/a>/);
    assert.match(html, /href="\/blog\?tag=product">Newer/);
    assert.match(html, /href="\/blog\?tag=product&amp;page=3">Older/);
    const head = buildBlogHead({ origin: ORIGIN, eff, locale: 'en', defaultLocale: 'en', locales: ['en'], siteName: 'Acme' });
    assert.match(head, /"@type":"Blog"/);
    assert.strictEqual(indexQuery({ page: 1 }), '');
});

// The live chrome: the design's logo is a 64 px favicon, the homepage is slugged `home`.
const CHROME = { design: { logo: 'cms/1700-favicon-64.png' }, pages: [{ id: 'p1', slug: 'home', title: 'Home', isHomepage: true }] };
/** @param {string} head */
const ogImage = (head) => (head.match(/<meta property="og:image" content="([^"]*)">/) || [])[1];
/** @param {string} head */
const titleOf = (head) => (head.match(/<title>([^<]*)<\/title>/) || [])[1];
/** @param {string} head */
const graphOf = (head) => JSON.parse(head.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1])['@graph'];

function indexEff(locale = 'en', title = 'Blog') {
    return {
        ...CHROME,
        page: { slug: 'blog', title, seo: { metaTitle: '', metaDescription: 'News', ogImage: '', noIndex: false }, blocks: [] },
        blog: {
            view: 'index', locale, defaultLocale: 'en', basePath: locale === 'en' ? '/blog' : `/${locale}/blog`, title, description: 'News', labels,
            posts: [], page: 1, pageCount: 1, total: 0, tag: null, tags: [], locales: ['en', 'nl'],
        },
    };
}

test('a post without a cover shares the site card, not the favicon-sized logo', () => {
    const eff = { ...postEff({ coverImage: '' }), ...CHROME };
    eff.page.seo.ogImage = '';
    const head = buildBlogHead({ origin: ORIGIN, eff, locale: 'en', defaultLocale: 'en', locales: ['en', 'nl'], siteName: 'Acme', shareImageVersion: 'v1' });
    assert.strictEqual(ogImage(head), 'https://site.test/api/cms/og/en/home.png?v=v1');
    assert.match(head, /<meta name="twitter:image" content="https:\/\/site.test\/api\/cms\/og\/en\/home.png\?v=v1">/);
    const nl = buildBlogHead({ origin: ORIGIN, eff, locale: 'nl', defaultLocale: 'en', locales: ['en', 'nl'], siteName: 'Acme', shareImageVersion: 'v1' });
    assert.strictEqual(ogImage(nl), 'https://site.test/api/cms/og/nl/home.png?v=v1');
    const posting = graphOf(head).find((n) => n['@type'] === 'BlogPosting');
    assert.strictEqual(posting.image, 'https://site.test/api/cms/og/en/home.png?v=v1');
});

test('a post with a cover shares its cover', () => {
    const eff = { ...postEff(), ...CHROME };
    const head = buildBlogHead({ origin: ORIGIN, eff, locale: 'en', defaultLocale: 'en', locales: ['en'], siteName: 'Acme', shareImageVersion: 'v1' });
    assert.strictEqual(ogImage(head), 'https://site.test/api/cms/asset/cms/1700-cover.jpg');
});

test('the blog index shares the site card and carries the site name in its title, in each language', () => {
    const en = buildBlogHead({ origin: ORIGIN, eff: indexEff('en'), locale: 'en', defaultLocale: 'en', locales: ['en', 'nl'], siteName: 'Acme', shareImageVersion: 'v1' });
    assert.strictEqual(titleOf(en), 'Blog | Acme');
    assert.strictEqual(ogImage(en), 'https://site.test/api/cms/og/en/home.png?v=v1');
    assert.match(en, /<link rel="canonical" href="https:\/\/site.test\/blog">/);
    const nl = buildBlogHead({ origin: ORIGIN, eff: indexEff('nl', 'Nieuws'), locale: 'nl', defaultLocale: 'en', locales: ['en', 'nl'], siteName: 'Acme', shareImageVersion: 'v1' });
    assert.strictEqual(titleOf(nl), 'Nieuws | Acme');
    assert.strictEqual(ogImage(nl), 'https://site.test/api/cms/og/nl/home.png?v=v1');
    assert.match(nl, /<link rel="canonical" href="https:\/\/site.test\/nl\/blog">/);
    assert.match(nl, /hreflang="en" href="https:\/\/site.test\/blog"/);
    assert.match(nl, /hreflang="nl" href="https:\/\/site.test\/nl\/blog"/);
    assert.match(nl, /hreflang="x-default" href="https:\/\/site.test\/blog"/);
    const named = buildBlogHead({ origin: ORIGIN, eff: indexEff('en', 'Acme blog'), locale: 'en', defaultLocale: 'en', locales: ['en'], siteName: 'Acme' });
    assert.strictEqual(titleOf(named), 'Acme blog', 'a title that already names the site is kept');
});

test('a post without its own meta title gets the site name; one with it keeps it', () => {
    const plain = buildBlogHead({ origin: ORIGIN, eff: postEff({ title: 'Hello' }), locale: 'en', defaultLocale: 'en', locales: ['en'], siteName: 'Acme' });
    assert.strictEqual(titleOf(plain), 'Hello | Acme');
    const eff = postEff({ title: 'Hello' });
    eff.page.seo.metaTitle = 'Hello there – Acme';
    const own = buildBlogHead({ origin: ORIGIN, eff, locale: 'en', defaultLocale: 'en', locales: ['en'], siteName: 'Acme' });
    assert.strictEqual(titleOf(own), 'Hello there – Acme');
});

test('an author named like the site is the Organization, not a Person', () => {
    for (const authorName of ['Acme', ' acme ']) {
        const head = buildBlogHead({ origin: ORIGIN, eff: postEff({ authorName }), locale: 'en', defaultLocale: 'en', locales: ['en'], siteName: 'Acme' });
        const posting = graphOf(head).find((n) => n['@type'] === 'BlogPosting');
        assert.deepStrictEqual(posting.author, { '@id': 'https://site.test/#organization' });
    }
    const person = buildBlogHead({ origin: ORIGIN, eff: postEff(), locale: 'en', defaultLocale: 'en', locales: ['en'], siteName: 'Acme' });
    assert.deepStrictEqual(graphOf(person).find((n) => n['@type'] === 'BlogPosting').author, { '@type': 'Person', name: 'Ann Writer' });
});

test('feed: valid RSS with escaped text, absolute links and safe HTML content', () => {
    const xml = buildFeed([{ ...postEff().blog.post, title: 'Fish & <Chips>\u0001' }], {
        origin: ORIGIN, siteName: 'Acme', title: 'Blog', description: '', locale: 'nl', defaultLocale: 'en', lastBuildDate: '2026-10-03T00:00:00Z',
    });
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.match(xml, /<title>Fish &amp; &lt;Chips&gt;<\/title>/, 'escaped, control character stripped');
    assert.match(xml, /<link>https:\/\/site.test\/nl\/blog\/hello-world<\/link>/);
    assert.match(xml, /atom:link href="https:\/\/site.test\/nl\/blog\/feed.xml" rel="self"/);
    assert.match(xml, /<pubDate>Thu, 01 Oct 2026 09:00:00 GMT<\/pubDate>/);
    assert.match(xml, /<dc:creator>Ann Writer<\/dc:creator>/);
    const content = xml.match(/<content:encoded>([^]*?)<\/content:encoded>/)[1];
    assert.ok(!content.includes('<'), 'HTML in the feed is entity-encoded');
    assert.ok(!/javascript/i.test(content));
    assert.match(content, /src=&quot;https:\/\/site.test\/api\/cms\/asset\/cms\/1700-cover.jpg/);
    assert.ok(!xml.includes('@'), 'no e-mail address ends up in the feed');
    assert.strictEqual(feedPath('en', 'en'), '/blog/feed.xml');
});

test('sitemap: index plus indexable posts, each in its own languages', () => {
    const entries = blogSitemapEntries({
        posts: [
            { id: 'po_1', slug: 'one', seo: {}, updatedAt: '2026-10-05T00:00:00Z' },
            { id: 'po_2', slug: 'hidden', seo: { noIndex: true }, updatedAt: '2026-10-04T00:00:00Z' },
        ],
        overridesLocales: { index: ['en', 'nl'], byPost: { po_1: ['en', 'nl'], po_2: ['en'] } },
        lastmod: '2026-10-01T00:00:00Z',
    });
    const xml = buildSitemap(entries, { origin: ORIGIN, defaultLocale: 'en', locales: ['en', 'nl'] });
    assert.match(xml, /<loc>https:\/\/site.test\/blog<\/loc>/);
    assert.match(xml, /<loc>https:\/\/site.test\/nl\/blog\/one<\/loc>/);
    assert.match(xml, /<lastmod>2026-10-05<\/lastmod>/);
    assert.ok(!xml.includes('hidden'), 'a noIndex post is not advertised');
    assert.deepStrictEqual(blogSitemapEntries({ posts: [], overridesLocales: { index: [], byPost: {} } }), []);
});

test('blog paths parse and round-trip; the feed and deeper paths are not pages', () => {
    assert.deepStrictEqual(parsePublicPath('/blog', ['en', 'nl']), { locale: null, slug: 'blog', blog: { view: 'index' } });
    assert.deepStrictEqual(parsePublicPath('/nl/blog/hello-world/', ['en', 'nl']),
        { locale: 'nl', slug: 'blog/hello-world', blog: { view: 'post', postSlug: 'hello-world' } });
    assert.strictEqual(parsePublicPath('/blog/feed.xml', ['en']), null);
    assert.strictEqual(parsePublicPath('/blog/a/b', ['en']), null);
    assert.strictEqual(parsePublicPath('/blog/Under_Score', ['en']), null);
    assert.strictEqual(buildPublicPath('nl', 'blog/hello-world', 'en'), '/nl/blog/hello-world');
});
