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
    assert.match(html, /<h3 id="part">Part<\/h3>/, 'a ## section sits under the title h1');
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
            page: 2, pageCount: 3, total: 21, tag: { slug: 'product', label: 'Product' }, tags: [],
        },
    };
    const html = renderBlogBody(eff);
    assert.match(html, /<h1>Tagged Product<\/h1>/);
    assert.match(html, /<a href="\/blog\/a-post">A &lt;post&gt;<\/a>/);
    assert.match(html, /href="\/blog\?tag=product">Newer/);
    assert.match(html, /href="\/blog\?tag=product&amp;page=3">Older/);
    const head = buildBlogHead({ origin: ORIGIN, eff, locale: 'en', defaultLocale: 'en', locales: ['en'], siteName: 'Acme' });
    assert.match(head, /"@type":"Blog"/);
    assert.strictEqual(indexQuery({ page: 1 }), '');
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
