// @typecheck
/**
 * Blog routes of the CMS.
 *
 *   ADMIN (mounted by routes/cms.js under /sites/:siteId/posts, behind the
 *   same requireAdmin + attachSiteIdFromParam as every per-site route):
 *     GET    …/posts                       list (summaries, no body)
 *     POST   …/posts                       create → PostDoc
 *     GET    …/posts/:postId               PostDoc + its translations
 *     PUT    …/posts/:postId               patch → PostDoc
 *     DELETE …/posts/:postId
 *     PUT    …/posts/:postId/locale/:locale    replace one translation
 *     DELETE …/posts/:postId/locale/:locale
 *
 *   PUBLIC (no auth, mounted as /api/cms/blog):
 *     GET    /posts?locale=&limit=&tag=     newest visible posts of the LIVE
 *                                           site's published snapshot, for the
 *                                           "latest posts" block. Summaries only.
 *
 * Edits land in the draft; visitors see posts only after Publish (and, for a
 * scheduled post, once its date has passed). Blog index settings (heading,
 * intro, posts per page) live on the SiteDoc as `site.blog` and are saved with
 * it, so the panel's own site autosave owns them.
 */

'use strict';

const express = require('express');
const cmsStore = require('../stores/cmsStore');
const { HttpError } = require('../core/http/errors');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, choice, closedObject, typeError } = require('../core/http/schemaParts');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { POST_LIMITS: LIMITS, POST_STATUSES } = require('../stores/cms/postLimits');
// Lazy: the store's aggregates are only needed when a request arrives.
/** @param {import('../stores/cms/shared').CmsDoc} post */
const summarize = (post) => require('../stores/cms/blogEffective').summarize(post);
const getLiveSiteId = () => require('./cmsShared').getLiveSiteId();
const POST_ID_RE = /^po_[a-f0-9]{4,}$/;
const LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

/**
 * @param {string} field
 * @param {number} max
 */
const text = (field, max) => worded(`${field} is text of at most ${max} characters.`).max(max, `${field} is at most ${max} characters.`);
const seoShape = closedObject({
    metaTitle: text('seo.metaTitle', LIMITS.metaTitle).optional(),
    metaDescription: text('seo.metaDescription', LIMITS.metaDescription).optional(),
    ogImage: text('seo.ogImage', 2048).optional(),
    noIndex: z.boolean({ error: typeError({ invalid: 'seo.noIndex is true or false.' }) }).optional(),
}, 'seo');
const postFields = {
    title: text('title', LIMITS.title),
    slug: text('slug', 200),
    excerpt: text('excerpt', LIMITS.excerpt),
    body: text('body', LIMITS.body),
    coverImage: text('coverImage', 2048),
    coverAlt: text('coverAlt', LIMITS.coverAlt),
    authorName: text('authorName', LIMITS.authorName),
    tags: z.array(text('A tag', LIMITS.tagLength), { error: typeError({ invalid: 'tags is a list of words.' }) })
        .max(LIMITS.tags, `At most ${LIMITS.tags} tags.`),
    status: choice(POST_STATUSES, `status is one of ${POST_STATUSES.join(', ')}.`),
    publishedAt: worded('publishedAt is an ISO date.').max(40).nullable(),
    seo: seoShape,
};
const optionalFields = Object.fromEntries(Object.entries(postFields).map(([k, v]) => [k, v.optional()]));
const createBody = validate({ body: bodyOf({ ...optionalFields, title: postFields.title }, 'Creating a post') });
const updateBody = validate({ body: bodyOf(optionalFields, 'Saving a post') });
const overrideBody = validate({
    body: bodyOf({
        override: closedObject({
            title: text('override.title', LIMITS.title).optional(),
            excerpt: text('override.excerpt', LIMITS.excerpt).optional(),
            body: text('override.body', LIMITS.body).optional(),
            coverAlt: text('override.coverAlt', LIMITS.coverAlt).optional(),
            seo: closedObject({
                metaTitle: text('override.seo.metaTitle', LIMITS.metaTitle).optional(),
                metaDescription: text('override.seo.metaDescription', LIMITS.metaDescription).optional(),
            }, 'override.seo').optional(),
            version: z.number().optional(),
        }, 'A post translation'),
    }, 'Saving a translation'),
});

// Same generous-but-bounded posture as the other CMS write routes: the threat
// is a stolen admin session filling the config table, not a normal editor.
const writeLimiter = perUserRateLimit({ windowMs: 60_000, max: 120 });

/**
 * Store errors that are the caller's fault become a 400 with their sentence.
 * @param {Error & { code?: string }} err
 */
function asHttp(err) {
    if (err && err.name === 'PostError') {
        return new HttpError(err.code === 'not_found' ? 404 : 400, err.code, err.message);
    }
    return err;
}

/** @param {import('express').Request} req */
function postIdParam(req) {
    const id = String(req.params.postId || '');
    if (!POST_ID_RE.test(id)) throw new HttpError(404, 'post_not_found', 'Post not found');
    return id;
}

/** @param {import('express').Request} req */
function localeParam(req) {
    const locale = String(req.params.locale || '').toLowerCase();
    if (!LOCALE_RE.test(locale)) throw new HttpError(400, 'invalid_locale', 'locale is a language code such as "nl".');
    return locale;
}

/** @param {import('../stores/cms/shared').CmsDoc} post */
function adminSummary(post) {
    return {
        ...summarize(post),
        status: post.status,
        createdAt: post.createdAt,
        hasCover: !!post.coverImage,
        seo: post.seo,
    };
}

function createAdminRouter() {
    const router = express.Router({ mergeParams: true });

    router.get('/', async (req, res) => {
        const posts = await cmsStore.listPosts(req.siteId, { fresh: true });
        const translations = await cmsStore.collectPostLocaleOverrides(req.siteId, { fresh: true });
        res.json({
            posts: posts.map(p => ({ ...adminSummary(p), translatedLocales: Object.keys(translations[p.id] || {}) })),
            limits: LIMITS,
        });
    });

    router.post('/', writeLimiter, createBody, async (req, res) => {
        try {
            const post = await cmsStore.createPost(req.siteId, req.body);
            res.status(201).json({ success: true, post });
        } catch (err) { throw asHttp(err); }
    });

    router.get('/:postId', async (req, res) => {
        const postId = postIdParam(req);
        const post = await cmsStore.getPost(req.siteId, postId, { fresh: true });
        if (!post) throw new HttpError(404, 'post_not_found', 'Post not found');
        const all = await cmsStore.collectPostLocaleOverrides(req.siteId, { fresh: true });
        res.json({ post, translations: all[postId] || {} });
    });

    router.put('/:postId', writeLimiter, updateBody, async (req, res) => {
        try {
            const post = await cmsStore.updatePost(req.siteId, postIdParam(req), req.body);
            res.json({ success: true, post });
        } catch (err) { throw asHttp(err); }
    });

    router.delete('/:postId', writeLimiter, async (req, res) => {
        const removed = await cmsStore.deletePost(req.siteId, postIdParam(req));
        if (!removed) throw new HttpError(404, 'post_not_found', 'Post not found');
        res.json({ success: true });
    });

    router.put('/:postId/locale/:locale', writeLimiter, overrideBody, async (req, res) => {
        const locale = localeParam(req);
        if (locale === await cmsStore.getDefaultLocale()) {
            throw new HttpError(400, 'default_locale', 'The default language is the post itself, not a translation.');
        }
        try {
            const override = await cmsStore.setPostLocaleOverride(req.siteId, postIdParam(req), locale, req.body.override);
            res.json({ success: true, override });
        } catch (err) { throw asHttp(err); }
    });

    router.delete('/:postId/locale/:locale', writeLimiter, async (req, res) => {
        await cmsStore.deletePostLocaleOverride(req.siteId, postIdParam(req), localeParam(req));
        res.json({ success: true });
    });

    return router;
}

function createPublicRouter() {
    const router = express.Router();
    // No schema on this query on purpose, like GET /api/cms/site: it feeds a
    // public page, and a refusal would blank a block instead of degrading.
    router.get('/posts', async (req, res) => {
        res.set('Cache-Control', 'public, max-age=60, s-maxage=120');
        const siteId = await getLiveSiteId();
        if (!siteId) return res.json({ posts: [] });
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- LOCALE_RE is anchored with one bounded character class (linear); the value comes from a short query param
        const locale = String(req.query.locale || '').toLowerCase().split('-')[0];
        const { posts, defaultLocale } = await cmsStore.getLatestPublishedPosts(siteId, {
            locale: LOCALE_RE.test(locale) ? locale : undefined,
            limit: Math.min(12, Math.max(1, Number.parseInt(String(req.query.limit || 3), 10) || 3)),
            tag: typeof req.query.tag === 'string' ? req.query.tag.slice(0, 60) : '',
        });
        const loc = LOCALE_RE.test(locale) ? locale : defaultLocale;
        const basePath = loc && defaultLocale && loc !== defaultLocale ? `/${loc}/blog` : '/blog';
        const labels = await require('../stores/cms/blogEffective').blogLabels(loc || 'en');
        return res.json({ posts, basePath, locale: loc || null, labels });
    });
    return router;
}

module.exports = { createAdminRouter, createPublicRouter, asHttp };
