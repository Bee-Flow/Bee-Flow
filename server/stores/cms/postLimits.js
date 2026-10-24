// @typecheck
/**
 * The size and vocabulary limits of a blog post, in one dependency-free module
 * so the store (stores/cms/posts.js, beside this file), the REST schemas (routes/cmsBlog.js) and
 * the editor-facing API all enforce the same numbers.
 */

'use strict';

const POST_STATUSES = Object.freeze(['draft', 'scheduled', 'published']);

const POST_LIMITS = Object.freeze({
    title: 200,
    slug: 96,
    excerpt: 500,
    body: 100_000,
    coverAlt: 200,
    authorName: 100,
    tags: 10,
    tagLength: 40,
    metaTitle: 200,
    metaDescription: 500,
    postsPerSite: 1000,
});

module.exports = { POST_STATUSES, POST_LIMITS };
