// @typecheck
// Blog posts: the PostDoc aggregate of a CMS site.
//
// Storage (config table, like every other CMS document):
//   cms_project_{siteId}_posts                     { version, posts: [{ id, slug }] }  membership + slug registry
//   cms_project_{siteId}_post_{postId}             PostDoc
//   cms_project_{siteId}_post_{postId}_locale_{xx} post-locale override (text only)
//
// Every key sits under cms_project_{siteId}_, so deleteProject's prefix sweep
// removes posts with their site. The post-locale keys contain `_locale_` but
// not `_page_`, and the page/site override readers (collectLocaleOverrides,
// publishSite) skip any tail that is neither, so they never mistake one for
// the other.
//
// The registry is written through configStore.mutateConfig (an advisory lock
// per key): two creates racing on different replicas can neither lose a post
// nor both claim one slug.
//
// A PostDoc holds no user id. The author is a free-text display name, so the
// public site and feed never carry a link to an account, and deleting a user
// has nothing to clean up here.
//
// The body is Markdown, stored as typed. It is made safe where it is RENDERED
// (core/cms/blogMarkdown.js on the server, BlogMarkdown.tsx in the browser),
// never trusted as HTML.

const configStore = require('../configStore');
const { getAll } = require('../../db');
const { sanitizeMediaRef } = require('./postText');
const {
    KEY_LOCALE_INFIX, LOCALE_OVERRIDE_VERSION,
    newId, isPlainObject, clone, assertSiteId, projectKey,
} = require('./shared');

const POST_VERSION = 1;
const POST_INDEX_VERSION = 1;
const KEY_POST_INFIX = '_post_';
const KEY_POSTS_SUFFIX = '_posts';

const { POST_STATUSES, POST_LIMITS } = require('./postLimits');
const { bestEffort } = require('../../utils/bestEffort');

// Path segments the blog itself claims under /blog/… (feed, tag and paging
// URLs), so no post may take them.
const RESERVED_POST_SLUGS = new Set(['feed', 'rss', 'atom', 'tag', 'tags', 'page', 'index', 'feed-xml']);

const POST_ID_RE = /^po_[a-f0-9]{4,}$/;

class PostError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'PostError';
        this.code = code;
    }
}

// ── Key builders ─────────────────────────────────────────────────────

function postsIndexKey(siteId)                 { return `${projectKey(siteId)}${KEY_POSTS_SUFFIX}`; }
function postKey(siteId, postId)               { return `${projectKey(siteId)}${KEY_POST_INFIX}${postId}`; }
function postLocaleKey(siteId, postId, locale) { return `${postKey(siteId, postId)}${KEY_LOCALE_INFIX}${locale}`; }

// ── Field sanitizers ─────────────────────────────────────────────────

/** Strip control characters (keep tab/newline) and cap the length. */
function text(value, max, { multiline = false } = {}) {
    if (typeof value !== 'string') return '';
    const cleaned = value.replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, multiline ? '' : ' ');
    const out = multiline ? cleaned : cleaned.trim();
    return out.length > max ? out.slice(0, max) : out;
}

/**
 * Post slug: lowercase ASCII letters, digits and single dashes — exactly what
 * the public router matches, so a stored slug is always reachable. Accents
 * fold to their base letter ("café" → "cafe") instead of disappearing.
 */
function normalizePostSlug(raw) {
    return String(raw || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, POST_LIMITS.slug)
        .replace(/-+$/g, '');
}

/** The URL form of a tag, for /blog?tag=… filtering. Same rules as a slug. */
function tagSlug(tag) {
    return normalizePostSlug(tag).slice(0, POST_LIMITS.tagLength);
}

function sanitizeTags(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of value) {
        const label = text(raw, POST_LIMITS.tagLength).replace(/\s+/g, ' ');
        const key = tagSlug(label);
        if (!label || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(label);
        if (out.length >= POST_LIMITS.tags) break;
    }
    return out;
}

function sanitizeIsoDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const t = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(t)) return undefined;   // undefined = "invalid", null = "none"
    // Sanity window: a typo like year 20250 must not schedule a post forever.
    const year = new Date(t).getUTCFullYear();
    if (year < 1990 || year > 2200) return undefined;
    return new Date(t).toISOString();
}

function emptySeo() {
    return { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false };
}

function sanitizeSeo(input, base = emptySeo()) {
    const s = isPlainObject(input) ? input : {};
    return {
        metaTitle: s.metaTitle !== undefined ? text(s.metaTitle, POST_LIMITS.metaTitle) : base.metaTitle,
        metaDescription: s.metaDescription !== undefined ? text(s.metaDescription, POST_LIMITS.metaDescription) : base.metaDescription,
        ogImage: s.ogImage !== undefined ? sanitizeMediaRef(s.ogImage) : base.ogImage,
        noIndex: s.noIndex !== undefined ? s.noIndex === true : !!base.noIndex,
    };
}

/**
 * Status + publish date, normalised together:
 *   published without a date → stamped now
 *   scheduled without a date → refused (there is nothing to schedule for)
 *   draft                    → keeps whatever date it had (shown in the editor)
 */
function resolveStatus(status, publishedAt, now) {
    if (!POST_STATUSES.includes(status)) {
        throw new PostError('invalid_status', `status must be one of ${POST_STATUSES.join(', ')}.`);
    }
    if (publishedAt === undefined) throw new PostError('invalid_date', 'publishedAt must be an ISO date such as 2026-11-01T09:00:00Z.');
    if (status === 'published' && !publishedAt) return { status, publishedAt: new Date(now).toISOString() };
    if (status === 'scheduled' && !publishedAt) {
        throw new PostError('schedule_needs_date', 'A scheduled post needs publishedAt: the moment it goes live.');
    }
    return { status, publishedAt };
}

/** True when visitors may see this post at `now` (and it is in a published snapshot). */
function isPostVisible(post, now = Date.now()) {
    if (!isPlainObject(post)) return false;
    if (post.status !== 'published' && post.status !== 'scheduled') return false;
    const t = Date.parse(post.publishedAt || '');
    return Number.isFinite(t) && t <= now;
}

// ── Registry (membership + slug uniqueness) ──────────────────────────

function emptyIndex() { return { version: POST_INDEX_VERSION, posts: [] }; }

function readIndexValue(v) {
    if (!isPlainObject(v) || !Array.isArray(v.posts)) return emptyIndex();
    return {
        version: POST_INDEX_VERSION,
        posts: v.posts.filter(e => isPlainObject(e) && typeof e.id === 'string' && typeof e.slug === 'string'),
    };
}

async function getPostsIndex(siteId, { fresh = false } = {}) {
    assertSiteId(siteId);
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    return readIndexValue(await read(postsIndexKey(siteId)));
}

function uniqueSlug(base, entries, ignoreId) {
    let candidate = base;
    let i = 2;
    while (entries.some(e => e.id !== ignoreId && e.slug === candidate) || RESERVED_POST_SLUGS.has(candidate)) {
        const suffix = `-${i++}`;
        candidate = `${base.slice(0, POST_LIMITS.slug - suffix.length)}${suffix}`;
    }
    return candidate;
}

// ── PostDoc CRUD ─────────────────────────────────────────────────────

async function getPost(siteId, postId, { fresh = false } = {}) {
    assertSiteId(siteId);
    if (typeof postId !== 'string' || !POST_ID_RE.test(postId)) return null;
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const v = await read(postKey(siteId, postId));
    return isPlainObject(v) ? v : null;
}

/** Every post of a site, newest first (publish date, else last edit). */
async function listPosts(siteId, { fresh = false } = {}) {
    const index = await getPostsIndex(siteId, { fresh });
    const posts = [];
    for (const entry of index.posts) {
        const doc = await getPost(siteId, entry.id, { fresh });
        if (doc) posts.push(doc);
    }
    return sortPosts(posts);
}

function sortPosts(posts) {
    const when = (p) => Date.parse(p.publishedAt || p.updatedAt || p.createdAt || '') || 0;
    return [...posts].sort((a, b) => when(b) - when(a));
}

async function findPostBySlug(siteId, slug, { fresh = false } = {}) {
    const wanted = normalizePostSlug(slug);
    if (!wanted) return null;
    const index = await getPostsIndex(siteId, { fresh });
    const entry = index.posts.find(e => e.slug === wanted);
    return entry ? getPost(siteId, entry.id, { fresh }) : null;
}

/**
 * Build a full PostDoc from input, on top of `base` (an existing doc for an
 * update, or defaults for a create). Only keys present in `input` change.
 */
function buildPostDoc(base, input, now) {
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
    const doc = clone(base);
    if (has('title')) doc.title = text(input.title, POST_LIMITS.title);
    if (has('excerpt')) doc.excerpt = text(input.excerpt, POST_LIMITS.excerpt, { multiline: true }).trim();
    if (has('body')) {
        if (typeof input.body !== 'string') throw new PostError('invalid_body', 'body must be Markdown text.');
        if (input.body.length > POST_LIMITS.body) {
            throw new PostError('body_too_large', `body is ${input.body.length} characters; the limit is ${POST_LIMITS.body}.`);
        }
        doc.body = text(input.body, POST_LIMITS.body, { multiline: true });
    }
    if (has('coverImage')) doc.coverImage = sanitizeMediaRef(input.coverImage);
    if (has('coverAlt')) doc.coverAlt = text(input.coverAlt, POST_LIMITS.coverAlt);
    if (has('authorName')) doc.authorName = text(input.authorName, POST_LIMITS.authorName);
    if (has('tags')) {
        if (!Array.isArray(input.tags)) throw new PostError('invalid_tags', 'tags must be a list of words.');
        if (input.tags.length > POST_LIMITS.tags * 3) throw new PostError('too_many_tags', `At most ${POST_LIMITS.tags} tags.`);
        doc.tags = sanitizeTags(input.tags);
    }
    if (has('seo')) {
        if (!isPlainObject(input.seo)) throw new PostError('invalid_seo', 'seo must be an object.');
        doc.seo = sanitizeSeo(input.seo, doc.seo || emptySeo());
    }
    if (has('status') || has('publishedAt')) {
        const status = has('status') ? input.status : doc.status;
        const publishedAt = has('publishedAt') ? sanitizeIsoDate(input.publishedAt) : doc.publishedAt;
        Object.assign(doc, resolveStatus(status, publishedAt, now));
    }
    doc.updatedAt = new Date(now).toISOString();
    return doc;
}

function defaultPost(id, now) {
    const iso = new Date(now).toISOString();
    return {
        version: POST_VERSION,
        id,
        slug: '',
        title: '',
        excerpt: '',
        body: '',
        coverImage: '',
        coverAlt: '',
        authorName: '',
        tags: [],
        status: 'draft',
        publishedAt: null,
        seo: emptySeo(),
        createdAt: iso,
        updatedAt: iso,
    };
}

/**
 * @param {string} siteId
 * @param {Record<string, unknown>} input  title (required) and any PostDoc field
 * @param {{ now?: number }} [opts]
 */
async function createPost(siteId, input = {}, { now = Date.now() } = {}) {
    assertSiteId(siteId);
    if (!isPlainObject(input)) throw new PostError('invalid_input', 'A post is an object.');
    const id = newId('po');
    const doc = buildPostDoc(defaultPost(id, now), input, now);
    if (!doc.title) throw new PostError('title_required', 'A post needs a title.');
    const wanted = normalizePostSlug(typeof input.slug === 'string' && input.slug ? input.slug : doc.title) || 'post';

    // Reserve the slug and the id in one locked step, THEN write the doc.
    // A doc without a registry entry would be invisible; a registry entry
    // without its doc is skipped by listPosts — so this order fails safe.
    let finalSlug = wanted;
    await configStore.mutateConfig(postsIndexKey(siteId), (cur) => {
        const index = readIndexValue(cur);
        if (index.posts.length >= POST_LIMITS.postsPerSite) {
            throw new PostError('too_many_posts', `A site holds at most ${POST_LIMITS.postsPerSite} posts.`);
        }
        finalSlug = uniqueSlug(wanted, index.posts, null);
        return { version: POST_INDEX_VERSION, posts: [...index.posts, { id, slug: finalSlug }] };
    });
    doc.slug = finalSlug;
    await configStore.setConfig(postKey(siteId, id), doc);
    return doc;
}

/**
 * Patch a post. `slug` is renamed through the registry (unique per site,
 * auto-suffixed like pages); everything else goes through buildPostDoc.
 */
async function updatePost(siteId, postId, patch = {}, { now = Date.now() } = {}) {
    assertSiteId(siteId);
    if (!isPlainObject(patch)) throw new PostError('invalid_input', 'A post patch is an object.');
    const current = await getPost(siteId, postId, { fresh: true });
    if (!current) throw new PostError('not_found', `Post "${String(postId).slice(0, 60)}" was not found.`);
    const doc = buildPostDoc(current, patch, now);
    if (!doc.title) throw new PostError('title_required', 'A post needs a title.');

    if (typeof patch.slug === 'string' && normalizePostSlug(patch.slug) !== current.slug) {
        const wanted = normalizePostSlug(patch.slug);
        if (!wanted) throw new PostError('invalid_slug', 'slug needs at least one letter or digit.');
        if (RESERVED_POST_SLUGS.has(wanted)) throw new PostError('reserved_slug', `"${wanted}" is used by the blog itself (feed, tags, paging). Pick another slug.`);
        let finalSlug = wanted;
        await configStore.mutateConfig(postsIndexKey(siteId), (cur) => {
            const index = readIndexValue(cur);
            finalSlug = uniqueSlug(wanted, index.posts, postId);
            const posts = index.posts.some(e => e.id === postId)
                ? index.posts.map(e => (e.id === postId ? { id: postId, slug: finalSlug } : e))
                : [...index.posts, { id: postId, slug: finalSlug }];
            return { version: POST_INDEX_VERSION, posts };
        });
        doc.slug = finalSlug;
    }
    await configStore.setConfig(postKey(siteId, postId), doc);
    return doc;
}

async function deletePost(siteId, postId) {
    assertSiteId(siteId);
    if (typeof postId !== 'string' || !POST_ID_RE.test(postId)) return false;
    const existed = !!(await getPost(siteId, postId, { fresh: true }));
    await configStore.mutateConfig(postsIndexKey(siteId), (cur) => {
        const index = readIndexValue(cur);
        return { version: POST_INDEX_VERSION, posts: index.posts.filter(e => e.id !== postId) };
    });
    await configStore.deleteConfig(postKey(siteId, postId));
    const rows = await getAll(
        'SELECT key FROM config WHERE key LIKE $1',
        [`${postKey(siteId, postId)}${KEY_LOCALE_INFIX}%`],
    );
    for (const r of rows) await configStore.deleteConfig(r.key);
    return existed;
}

// ── Post-locale overrides (translations) ─────────────────────────────

/** Text-only patch; structure (slug, tags, images, dates) is never translated. */
function sanitizePostOverride(input) {
    const o = isPlainObject(input) ? input : {};
    const out = { version: LOCALE_OVERRIDE_VERSION };
    if (typeof o.title === 'string') out.title = text(o.title, POST_LIMITS.title);
    if (typeof o.excerpt === 'string') out.excerpt = text(o.excerpt, POST_LIMITS.excerpt, { multiline: true });
    if (typeof o.body === 'string') {
        if (o.body.length > POST_LIMITS.body) {
            throw new PostError('body_too_large', `The translated body is ${o.body.length} characters; the limit is ${POST_LIMITS.body}.`);
        }
        out.body = text(o.body, POST_LIMITS.body, { multiline: true });
    }
    if (typeof o.coverAlt === 'string') out.coverAlt = text(o.coverAlt, POST_LIMITS.coverAlt);
    if (isPlainObject(o.seo)) {
        const seo = {};
        if (typeof o.seo.metaTitle === 'string') seo.metaTitle = text(o.seo.metaTitle, POST_LIMITS.metaTitle);
        if (typeof o.seo.metaDescription === 'string') seo.metaDescription = text(o.seo.metaDescription, POST_LIMITS.metaDescription);
        if (Object.keys(seo).length) out.seo = seo;
    }
    return out;
}

/** Does an override carry any real translated text? (An empty shell is not a translation.) */
function hasPostTranslation(override) {
    if (!isPlainObject(override)) return false;
    for (const k of ['title', 'excerpt', 'body']) {
        if (typeof override[k] === 'string' && override[k].trim()) return true;
    }
    return isPlainObject(override.seo) && Object.values(override.seo).some(v => String(v ?? '').trim() !== '');
}

async function getPostLocaleOverride(siteId, postId, locale, { fresh = false } = {}) {
    assertSiteId(siteId);
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const v = await read(postLocaleKey(siteId, postId, locale));
    return isPlainObject(v) ? v : null;
}

async function setPostLocaleOverride(siteId, postId, locale, override) {
    assertSiteId(siteId);
    if (!(await getPost(siteId, postId, { fresh: true }))) throw new PostError('not_found', 'Post not found.');
    const sanitized = sanitizePostOverride(override);
    await configStore.setConfig(postLocaleKey(siteId, postId, locale), sanitized);
    return sanitized;
}

async function deletePostLocaleOverride(siteId, postId, locale) {
    assertSiteId(siteId);
    await configStore.deleteConfig(postLocaleKey(siteId, postId, locale));
}

/**
 * Every post translation of a site: { [postId]: { [locale]: override } }.
 * Read through the registry (not a LIKE scan) so it agrees with listPosts.
 */
async function collectPostLocaleOverrides(siteId, { fresh = false, locales = null } = {}) {
    const index = await getPostsIndex(siteId, { fresh });
    const out = {};
    if (!index.posts.length) return out;
    const rows = await getAll(
        'SELECT key FROM config WHERE key LIKE $1',
        [`${projectKey(siteId)}${KEY_POST_INFIX}%${KEY_LOCALE_INFIX}%`],
    );
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const ids = new Set(index.posts.map(e => e.id));
    const prefix = `${projectKey(siteId)}${KEY_POST_INFIX}`;
    for (const r of rows) {
        if (!r.key.startsWith(prefix)) continue;
        const tail = r.key.substring(prefix.length);
        const at = tail.indexOf(KEY_LOCALE_INFIX);
        if (at < 0) continue;
        const postId = tail.substring(0, at);
        const locale = tail.substring(at + KEY_LOCALE_INFIX.length);
        if (!ids.has(postId) || (locales && !locales.includes(locale))) continue;
        const v = await read(r.key);
        if (!isPlainObject(v)) continue;
        out[postId] = out[postId] || {};
        out[postId][locale] = v;
    }
    return out;
}

// ── Bulk restore (duplicate / import) ────────────────────────────────

/**
 * Write a list of posts into a site with FRESH ids, keeping their content,
 * status and dates. Returns { idMap: Map(oldId|index → newId), count }.
 * `translations` is { [oldId]: { [locale]: override } }.
 */
async function restorePosts(siteId, posts, translations = {}, { now = Date.now() } = {}) {
    assertSiteId(siteId);
    const list = Array.isArray(posts) ? posts.slice(0, POST_LIMITS.postsPerSite) : [];
    const idMap = new Map();
    const entries = [];
    const docs = [];
    for (let i = 0; i < list.length; i++) {
        const src = list[i];
        if (!isPlainObject(src)) continue;
        const id = newId('po');
        let doc;
        try {
            const base = defaultPost(id, now);
            doc = buildPostDoc(base, {
                title: src.title, excerpt: src.excerpt, body: typeof src.body === 'string' ? src.body.slice(0, POST_LIMITS.body) : '',
                coverImage: src.coverImage, coverAlt: src.coverAlt, authorName: src.authorName,
                tags: Array.isArray(src.tags) ? src.tags.slice(0, POST_LIMITS.tags) : [],
                seo: isPlainObject(src.seo) ? src.seo : emptySeo(),
            }, now);
            const status = POST_STATUSES.includes(src.status) ? src.status : 'draft';
            const publishedAt = sanitizeIsoDate(src.publishedAt) || null;
            Object.assign(doc, status === 'scheduled' && !publishedAt ? { status: 'draft', publishedAt } : resolveStatus(status, publishedAt, now));
            const created = sanitizeIsoDate(src.createdAt);
            if (created) doc.createdAt = created;
            const updated = sanitizeIsoDate(src.updatedAt);
            if (updated) doc.updatedAt = updated;
        } catch (_) {
            continue;   // a malformed post is skipped, never half-written
        }
        if (!doc.title) doc.title = 'Untitled post';
        doc.slug = uniqueSlug(normalizePostSlug(src.slug || doc.title) || 'post', entries, null);
        entries.push({ id, slug: doc.slug });
        docs.push(doc);
        idMap.set(typeof src.id === 'string' && src.id ? src.id : `#${i}`, id);
    }
    await configStore.mutateConfig(postsIndexKey(siteId), (cur) => {
        const index = readIndexValue(cur);
        const merged = [...index.posts];
        for (const e of entries) {
            if (merged.length >= POST_LIMITS.postsPerSite) break;
            merged.push({ id: e.id, slug: uniqueSlug(e.slug, merged, null) });
        }
        return { version: POST_INDEX_VERSION, posts: merged };
    });
    for (const doc of docs) await configStore.setConfig(postKey(siteId, doc.id), doc);
    for (const [oldId, byLocale] of Object.entries(isPlainObject(translations) ? translations : {})) {
        const newPostId = idMap.get(oldId);
        if (!newPostId || !isPlainObject(byLocale)) continue;
        for (const [locale, override] of Object.entries(byLocale)) {
            if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(locale) || !isPlainObject(override)) continue;
            try {
                await configStore.setConfig(postLocaleKey(siteId, newPostId, locale), sanitizePostOverride(override));
            } catch (err) { bestEffort('stores/cms/posts:restorePosts', err); /* oversized translation: skipped */ }
        }
    }
    return { idMap, count: docs.length };
}

module.exports = {
    POST_VERSION, POST_STATUSES, POST_LIMITS, RESERVED_POST_SLUGS, POST_ID_RE,
    KEY_POST_INFIX, PostError,
    postKey, postLocaleKey, postsIndexKey,
    normalizePostSlug, tagSlug, sanitizeMediaRef, sanitizeTags, sanitizeSeo,
    sanitizePostOverride, hasPostTranslation, isPostVisible, sortPosts,
    getPostsIndex, listPosts, getPost, findPostBySlug,
    createPost, updatePost, deletePost,
    getPostLocaleOverride, setPostLocaleOverride, deletePostLocaleOverride,
    collectPostLocaleOverrides, restorePosts,
};
