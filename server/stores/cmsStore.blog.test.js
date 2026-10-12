/**
 * Blog posts in the CMS store — the PostDoc aggregate end to end on an
 * in-memory config table:
 *
 *   - create/update: slug normalising, uniqueness, reserved slugs, status and
 *     date rules, field caps and the media-URL gate;
 *   - publishing: drafts never enter the snapshot, scheduled posts appear on
 *     their date without another publish;
 *   - the visitor view (getEffectiveBlog): visibility, translation merge,
 *     tag filter, paging, noIndex on navigation views;
 *   - duplicate / export / import / delete carry posts and translations;
 *     deleting a site removes every post row.
 *
 * Run: node --test stores/cmsStore.blog.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// The store runs REAL against an in-memory config table, served through the
// database pool seam of core/http/routeHarness (no module-system mocking):
// the handful of statements configStore issues are answered from a Map.
const { recordDb } = require('../core/http/routeHarness');

const configState = { map: new Map() };
function likeToRegex(pattern) {
    const esc = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${esc.replace(/%/g, '.*').replace(/_/g, '.')}$`);
}
const keysLike = (p) => [...configState.map.keys()].filter((k) => likeToRegex(p).test(k)).map((key) => ({ key }));
recordDb((sql, params = []) => {
    if (/^\s*SELECT value FROM config WHERE key = \$1/i.test(sql)) {
        return { rows: configState.map.has(params[0]) ? [{ value: configState.map.get(params[0]) }] : [] };
    }
    if (/INSERT INTO config/i.test(sql)) { configState.map.set(params[0], params[1]); return { rows: [], rowCount: 1 }; }
    if (/^\s*DELETE FROM config WHERE key = \$1/i.test(sql)) {
        const had = configState.map.delete(params[0]);
        return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (/SELECT key FROM config WHERE key = \$1 OR key LIKE \$2/i.test(sql)) {
        return { rows: [...(configState.map.has(params[0]) ? [{ key: params[0] }] : []), ...keysLike(params[1])] };
    }
    if (/SELECT key FROM config WHERE key LIKE \$1/i.test(sql)) return { rows: keysLike(params[0]) };
    return undefined;
});

const cmsStore = require('./cmsStore');

const posts = require('./cms/posts');

const DAY = 24 * 3600 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

async function newSite(name = 'Blog site') {
    const { id } = await cmsStore.createProject({ name });
    return id;
}

test('create: slug from the title, accents folded, unique per site, reserved words skipped', async () => {
    const siteId = await newSite();
    const a = await cmsStore.createPost(siteId, { title: 'Café Privacy: how we work!' });
    assert.strictEqual(a.slug, 'cafe-privacy-how-we-work');
    assert.strictEqual(a.status, 'draft');
    assert.strictEqual(a.publishedAt, null);
    const b = await cmsStore.createPost(siteId, { title: 'Other', slug: 'Cafe Privacy How We Work' });
    assert.strictEqual(b.slug, 'cafe-privacy-how-we-work-2');
    const feed = await cmsStore.createPost(siteId, { title: 'x', slug: 'feed' });
    assert.notStrictEqual(feed.slug, 'feed', 'feed is the RSS path under /blog');
    await assert.rejects(cmsStore.updatePost(siteId, a.id, { slug: 'tag' }), /used by the blog itself/);
    await assert.rejects(cmsStore.createPost(siteId, { title: '   ' }), /needs a title/);
});

test('status rules: published gets a date, scheduled needs one, bad dates are refused', async () => {
    const siteId = await newSite();
    const p = await cmsStore.createPost(siteId, { title: 'Now', status: 'published' });
    assert.ok(p.publishedAt && Date.parse(p.publishedAt) <= Date.now());
    await assert.rejects(cmsStore.createPost(siteId, { title: 'Later', status: 'scheduled' }), /needs publishedAt/);
    await assert.rejects(cmsStore.createPost(siteId, { title: 'Bad', status: 'published', publishedAt: 'yesterday-ish' }), /ISO date/);
    await assert.rejects(cmsStore.createPost(siteId, { title: 'Far', status: 'scheduled', publishedAt: '20250-01-01' }), /ISO date/);
    await assert.rejects(cmsStore.createPost(siteId, { title: 'X', status: 'live' }), /status must be one of/);
});

test('fields are capped and unsafe media URLs are dropped', async () => {
    const siteId = await newSite();
    const p = await cmsStore.createPost(siteId, {
        title: 'T'.repeat(500),
        coverImage: 'javascript:alert(1)',
        tags: ['A', 'a', 'B  c', ...Array.from({ length: 20 }, (_, i) => `t${i}`)],
        seo: { ogImage: 'data:image/png;base64,xx', metaTitle: 'ok', noIndex: 'yes' },
        authorName: 'Ann\u0000 Writer',
    });
    assert.strictEqual(p.title.length, posts.POST_LIMITS.title);
    assert.strictEqual(p.coverImage, '');
    assert.strictEqual(p.seo.ogImage, '');
    assert.strictEqual(p.seo.noIndex, false, 'only a real true turns noIndex on');
    assert.deepStrictEqual(p.tags.slice(0, 2), ['A', 'B c'], 'tags are de-duplicated case-insensitively');
    assert.strictEqual(p.tags.length, posts.POST_LIMITS.tags);
    const ok = await cmsStore.updatePost(siteId, p.id, { coverImage: 'cms/1700-cover.jpg', seo: { ogImage: 'https://cdn.example.com/a.png' } });
    assert.strictEqual(ok.coverImage, 'cms/1700-cover.jpg');
    assert.strictEqual(ok.seo.ogImage, 'https://cdn.example.com/a.png');
    assert.strictEqual(ok.seo.metaTitle, 'ok', 'seo is a patch');
    await assert.rejects(cmsStore.updatePost(siteId, p.id, { body: 'x'.repeat(posts.POST_LIMITS.body + 1) }), /limit is/);
});

test('the PostDoc holds no user id, and delete removes the post and its translations', async () => {
    const siteId = await newSite();
    const p = await cmsStore.createPost(siteId, { title: 'Gone soon', body: 'hi' });
    assert.ok(!Object.keys(p).some(k => /user|owner|createdBy/i.test(k)));
    await cmsStore.setPostLocaleOverride(siteId, p.id, 'nl', { title: 'Binnenkort weg' });
    assert.ok(await cmsStore.deletePost(siteId, p.id));
    assert.strictEqual(await cmsStore.getPost(siteId, p.id), null);
    assert.ok(![...configState.map.keys()].some(k => k.includes(p.id)), 'no row of the post survives');
    assert.deepStrictEqual(await cmsStore.listPosts(siteId), []);
});

test('publish: drafts stay out of the snapshot, scheduled posts show up on their date', async () => {
    const siteId = await newSite();
    const live = await cmsStore.createPost(siteId, { title: 'Live post', status: 'published', publishedAt: iso(-DAY), tags: ['Product'] });
    const draft = await cmsStore.createPost(siteId, { title: 'Secret draft' });
    const later = await cmsStore.createPost(siteId, { title: 'Next week', status: 'scheduled', publishedAt: iso(7 * DAY) });
    await cmsStore.publishSite(siteId);
    const snap = await cmsStore.getPublishedSnapshot(siteId);
    assert.ok(snap.posts[live.id]);
    assert.ok(!snap.posts[draft.id], 'a draft never reaches the published snapshot');
    assert.ok(snap.posts[later.id], 'scheduled posts ride along with their date');

    const now = await cmsStore.getEffectiveBlog(siteId, { view: 'index' });
    assert.deepStrictEqual(now.blog.posts.map(p => p.slug), ['live-post']);
    const inEightDays = await cmsStore.getEffectiveBlog(siteId, { view: 'index', now: Date.now() + 8 * DAY });
    assert.deepStrictEqual(inEightDays.blog.posts.map(p => p.slug), ['next-week', 'live-post']);

    const missing = await cmsStore.getEffectiveBlog(siteId, { view: 'post', postSlug: 'secret-draft' });
    assert.strictEqual(missing.found, false);
    const preview = await cmsStore.getEffectiveBlog(siteId, { state: 'draft', view: 'post', postSlug: 'secret-draft' });
    assert.strictEqual(preview.found, true, 'the draft view shows a post whatever its status');

    // Later edits stay private until the next publish.
    await cmsStore.updatePost(siteId, live.id, { title: 'Edited after publish' });
    const still = await cmsStore.getEffectiveBlog(siteId, { view: 'post', postSlug: 'live-post' });
    assert.strictEqual(still.blog.post.title, 'Live post');
});

test('visitor view: translation merge, hreflang locales, tag filter, paging and noIndex', async () => {
    const siteId = await newSite();
    const site = await cmsStore.getProject(siteId);
    await cmsStore.setProject(siteId, { ...site, blog: { title: { en: 'News', nl: 'Nieuws' }, postsPerPage: 2 } });
    const made = [];
    for (let i = 0; i < 5; i++) {
        made.push(await cmsStore.createPost(siteId, {
            title: `Post ${i}`, body: `Body ${i}`, status: 'published', publishedAt: iso(-(i + 1) * DAY),
            tags: i % 2 ? ['Privacy'] : ['Product'],
        }));
    }
    await cmsStore.setPostLocaleOverride(siteId, made[0].id, 'nl', { title: 'Bericht 0', body: '', excerpt: 'Samenvatting' });
    await cmsStore.publishSite(siteId);

    const first = await cmsStore.getEffectiveBlog(siteId, { view: 'index', siteLocales: ['en', 'nl'] });
    assert.strictEqual(first.blog.title, 'News');
    assert.strictEqual(first.blog.pageCount, 3);
    assert.deepStrictEqual(first.blog.posts.map(p => p.slug), ['post-0', 'post-1']);
    assert.strictEqual(first.page.seo.noIndex, false);
    assert.deepStrictEqual(first.blog.locales, ['en', 'nl']);
    assert.deepStrictEqual(first.blog.tags.map(t => t.slug).sort(), ['privacy', 'product']);

    const page3 = await cmsStore.getEffectiveBlog(siteId, { view: 'index', page: 3 });
    assert.deepStrictEqual(page3.blog.posts.map(p => p.slug), ['post-4']);
    assert.strictEqual(page3.page.seo.noIndex, true, 'paged views are navigation, not content');

    const tagged = await cmsStore.getEffectiveBlog(siteId, { view: 'index', tag: 'privacy' });
    assert.deepStrictEqual(tagged.blog.posts.map(p => p.slug), ['post-1', 'post-3']);
    assert.strictEqual(tagged.page.seo.noIndex, true);

    const nl = await cmsStore.getEffectiveBlog(siteId, { view: 'post', postSlug: 'post-0', locale: 'nl', siteLocales: ['en', 'nl'] });
    assert.strictEqual(nl.blog.title, 'Nieuws');
    assert.strictEqual(nl.blog.post.title, 'Bericht 0');
    assert.strictEqual(nl.blog.post.body, 'Body 0', 'an empty translated field falls back to the source');
    assert.strictEqual(nl.blog.post.excerpt, 'Samenvatting');
    assert.deepStrictEqual(nl.blog.locales, ['en', 'nl']);
    assert.strictEqual(nl.blog.basePath, '/nl/blog');
    assert.strictEqual(nl.blog.older.slug, 'post-1');
    const untranslated = await cmsStore.getEffectiveBlog(siteId, { view: 'post', postSlug: 'post-2', siteLocales: ['en', 'nl'] });
    assert.deepStrictEqual(untranslated.blog.locales, ['en']);
    assert.strictEqual(nl.page.slug, 'blog/post-0');
    assert.ok(nl.header, 'the site chrome comes along');
});

test('duplicate, export and import carry posts and their translations; delete site removes them', async () => {
    const siteId = await newSite('Original');
    const p = await cmsStore.createPost(siteId, {
        title: 'Hello', body: 'See ![chart](cms/1700-chart.png)', coverImage: 'cms/1700-cover.jpg',
        status: 'published', publishedAt: iso(-DAY), tags: ['News'],
    });
    await cmsStore.setPostLocaleOverride(siteId, p.id, 'nl', { title: 'Hallo' });
    const site = await cmsStore.getProject(siteId);
    await cmsStore.setProject(siteId, { ...site, blog: { title: { en: 'Journal' } } });

    const copy = await cmsStore.duplicateProject(siteId);
    const copied = await cmsStore.listPosts(copy.id);
    assert.strictEqual(copied.length, 1);
    assert.notStrictEqual(copied[0].id, p.id, 'fresh ids');
    assert.strictEqual(copied[0].slug, 'hello');
    assert.strictEqual(copied[0].status, 'published');
    assert.strictEqual((await cmsStore.getPostLocaleOverride(copy.id, copied[0].id, 'nl')).title, 'Hallo');
    assert.deepStrictEqual((await cmsStore.getProject(copy.id)).blog.title, { en: 'Journal' });

    const bundle = await cmsStore.exportSite(siteId);
    assert.strictEqual(bundle.site.posts.length, 1);
    assert.ok(!('id' in bundle.site.posts[0]), 'exports carry no runtime ids');
    const keys = cmsStore.collectAssetKeys(bundle);
    assert.ok(keys.has('cms/1700-cover.jpg') && keys.has('cms/1700-chart.png'), 'cover and body images ride in the zip');
    assert.ok(bundle.site.locales.includes('nl'));

    const imported = await cmsStore.importSite(bundle);
    assert.strictEqual(imported.posts, 1);
    const ip = await cmsStore.listPosts(imported.siteId);
    assert.strictEqual(ip[0].title, 'Hello');
    assert.strictEqual((await cmsStore.getPostLocaleOverride(imported.siteId, ip[0].id, 'nl')).title, 'Hallo');

    await assert.rejects(cmsStore.importSite({ ...bundle, site: { ...bundle.site, posts: Array.from({ length: posts.POST_LIMITS.postsPerSite + 1 }, () => ({ title: 'x' })) } }), /Too many blog posts/);

    await cmsStore.deleteProject(siteId);
    assert.ok(![...configState.map.keys()].some(k => k.startsWith(`cms_project_${siteId}`)), 'site delete sweeps every post row');
});

test('post rows never confuse the page translation readers', async () => {
    const siteId = await newSite();
    const p = await cmsStore.createPost(siteId, { title: 'X' });
    await cmsStore.setPostLocaleOverride(siteId, p.id, 'nl', { title: 'Y' });
    const { siteByLocale, pagesByLocale } = await cmsStore.collectLocaleOverrides(siteId);
    assert.deepStrictEqual(siteByLocale, {});
    assert.deepStrictEqual(pagesByLocale, {});
});
