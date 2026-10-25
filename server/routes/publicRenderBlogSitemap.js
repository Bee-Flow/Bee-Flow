// @typecheck strict
/**
 * The blog's entries of sitemap.xml: the index and every post visitors can see
 * now, each in the languages it is translated into. Split out of
 * routes/publicRender.js.
 */

const cmsStore = require('../stores/cmsStore');
const { blogSitemapEntries } = require('../core/seo/blog');

/**
 * @param {string} siteId
 * @param {{ snapshot: import('../stores/cms/shared').CmsDoc, defaultLocale: string, locales: string[], lastmod?: string }} opts
 */
async function blogSitemap(siteId, { snapshot, defaultLocale, locales, lastmod }) {
    if (!snapshot?.posts || !Object.keys(snapshot.posts).length) return [];
    // A legacy page slugged "blog" owns /blog; the posts below it still list.
    const { posts } = await cmsStore.getLatestPublishedPosts(siteId, { locale: defaultLocale, limit: 50_000 });
    const { localesForPost } = require('../stores/cms/blogEffective');
    const overrides = snapshot.postLocaleOverrides || {};
    /** @type {Record<string, string[]>} */
    const byPost = {};
    for (const p of posts) byPost[p.id] = localesForPost(overrides, p.id, defaultLocale, locales);
    const index = [defaultLocale, ...locales.filter(/** @param {string} l */ l => l !== defaultLocale && posts.some(p => byPost[p.id].includes(l)))];
    const full = posts.map(p => ({ ...p, seo: snapshot.posts[p.id]?.seo || {} }));
    return blogSitemapEntries({ posts: full, overridesLocales: { index, byPost }, lastmod });
}

module.exports = { blogSitemap };
