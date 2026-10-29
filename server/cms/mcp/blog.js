// @typecheck strict
/**
 * Blog tools of the CMS MCP server: list, read, write and delete posts, edit a
 * post's Markdown body in place, translate it, and set the blog index heading.
 *
 * Same access model as every other CMS tool — dispatch.js runs the scope check
 * (read-only vs write; nothing here is publish-class) and the CMS admin test
 * before any handler, and the shared MCP gate has already applied the token,
 * account state, org policies (home org and group orgs, strictest wins), IP
 * allow-lists and the request rate limit. On top of that, writes here have
 * their own per-user budget, every list is capped, and creating or deleting a
 * post is audited (ids and slugs only — never post text).
 *
 * Posts are DRAFT edits: visitors see them only after cms_publish (which needs
 * the cms.publish scope), and a scheduled post only once its date has passed.
 *
 * The body is Markdown. Raw HTML in it is shown as text and unsafe link
 * schemes (javascript:, data:, …) are dropped when the page is rendered, so a
 * post can never carry script; `warnings` in a result says when that happened.
 */

'use strict';

const { sanitizeMediaRef } = require('../../core/cms/blogMarkdown');
const { WRITE_WINDOW_MS, WRITE_MAX_PER_WINDOW, LIST_MAX, BODY_EDITS_MAX, FIND_MAX_CHARS, POST_PROPS, BLOG_TOOLS, isPlainObject, err, postWarnings, visibleNow } = require('./blogPostWarnings');

/**
 * @typedef {import('./handlerKit').ToolArgs} ToolArgs
 * @typedef {import('./handlerKit').McpCtx} McpCtx
 * @typedef {Record<string, any>} Post  one blog post as the store holds it
 */

/**
 * @param {{ cmsStore: any, resolveSite: Function, audit: Function, now?: () => number }} deps
 */
function createBlogHandlers(deps) {
    const { cmsStore, resolveSite } = deps;
    const now = deps.now || Date.now;
    const budget = new Map();

    /** @param {string} userId */
    function takeWriteBudget(userId) {
        const t = now();
        const entry = budget.get(userId);
        if (!entry || entry.resetAt <= t) { budget.set(userId, { count: 1, resetAt: t + WRITE_WINDOW_MS }); return true; }
        if (entry.count >= WRITE_MAX_PER_WINDOW) return false;
        entry.count += 1;
        return true;
    }
    const budgetSpent = () => err(`Blog write budget spent (${WRITE_MAX_PER_WINDOW} changes per ${WRITE_WINDOW_MS / 60000} minutes). Wait a few minutes, and batch edits (bodyEdits takes up to ${BODY_EDITS_MAX} at once).`);

    const storeError = (/** @type {Error & { code?: string }} */ e) => {
        if (e && e.name === 'PostError') return err(e.message, { code: e.code });
        throw e;
    };

    /**
     * @param {string} siteId
     * @param {ToolArgs} args
     */
    async function findPost(siteId, args) {
        if (typeof args.postId === 'string' && args.postId) {
            const post = await cmsStore.getPost(siteId, args.postId, { fresh: true });
            if (post) return post;
        } else if (typeof args.slug === 'string' && args.slug) {
            const post = await cmsStore.findPostBySlug(siteId, args.slug, { fresh: true });
            if (post) return post;
        }
        return null;
    }
    /**
     * @param {string} siteId
     * @param {ToolArgs} args
     */
    async function notFoundHint(siteId, args) {
        const posts = await cmsStore.listPosts(siteId, { fresh: true });
        const list = posts.slice(0, 15).map((/** @type {Post} */ p) => `${p.id} (${p.slug})`).join(', ') || 'none yet';
        return err(`No post ${JSON.stringify(String(args.postId || args.slug || '').slice(0, 60))} in this site.`, { _fixHint: `Pass postId or slug. Posts: ${list}. cms_list_posts lists them all.` });
    }

    /**
     * Copy only the post fields an agent may set; reject anything else by name.
     * @param {ToolArgs} args
     * @param {Set<string>} allowed
     */
    function pickFields(args, allowed) {
        const unknown = Object.keys(args).filter(k => !allowed.has(k));
        if (unknown.length) {
            return { error: err(`Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).join(', ')}.`, { _fixHint: `Valid fields: ${[...allowed].join(', ')}.` }) };
        }
        /** @type {Record<string, any>} */
        const out = {};
        for (const k of Object.keys(POST_PROPS)) if (args[k] !== undefined) out[k] = args[k];
        if (out.seo !== undefined && !isPlainObject(out.seo)) return { error: err('seo must be an object.') };
        if (out.tags !== undefined && (!Array.isArray(out.tags) || out.tags.length > 10 || out.tags.some((/** @type {unknown} */ t) => typeof t !== 'string'))) {
            return { error: err('tags must be a list of at most 10 short words.') };
        }
        for (const k of ['title', 'slug', 'excerpt', 'body', 'coverImage', 'coverAlt', 'authorName', 'status', 'publishedAt']) {
            if (out[k] !== undefined && typeof out[k] !== 'string') return { error: err(`${k} must be text.`) };
        }
        if (out.coverImage && !sanitizeMediaRef(out.coverImage)) {
            return { error: err(`coverImage "${out.coverImage.slice(0, 80)}" is not an asset url or https URL.`, { _fixHint: 'Use the url from cms_list_assets or from the cms_request_upload curl answer (/api/cms/asset/cms/…), or an https:// URL.' }) };
        }
        return { fields: out };
    }

    /**
     * @param {Post} post
     * @param {Record<string, unknown>} [translations]
     */
    function shape(post, translations) {
        return {
            id: post.id, slug: post.slug, path: `/blog/${post.slug}`,
            title: post.title, excerpt: post.excerpt, status: post.status, publishedAt: post.publishedAt,
            visibleAfterPublish: visibleNow(post, now()),
            tags: post.tags, authorName: post.authorName, coverImage: post.coverImage, coverAlt: post.coverAlt,
            seo: post.seo, createdAt: post.createdAt, updatedAt: post.updatedAt,
            ...(translations ? { translatedLocales: Object.keys(translations) } : {}),
        };
    }

    /** @param {ToolArgs} args */
    async function listPosts(args) {
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        const limit = Math.min(LIST_MAX, Math.max(1, Number.isInteger(args.limit) ? args.limit : 50));
        const offset = Math.max(0, Number.isInteger(args.offset) ? args.offset : 0);
        const search = typeof args.search === 'string' ? args.search.toLowerCase().slice(0, 100) : '';
        const tag = typeof args.tag === 'string' ? args.tag.toLowerCase().trim() : '';
        const all = await cmsStore.listPosts(site.siteId, { fresh: true });
        const translations = await cmsStore.collectPostLocaleOverrides(site.siteId, { fresh: true });
        const filtered = all
            .filter((/** @type {Post} */ p) => !args.status || p.status === args.status)
            .filter((/** @type {Post} */ p) => !tag || (p.tags || []).some((/** @type {string} */ t) => t.toLowerCase() === tag))
            .filter((/** @type {Post} */ p) => !search || `${p.title} ${p.slug} ${p.excerpt}`.toLowerCase().includes(search));
        return {
            result: {
                siteId: site.siteId,
                total: filtered.length,
                offset,
                posts: filtered.slice(offset, offset + limit).map((/** @type {Post} */ p) => shape(p, translations[p.id] || {})),
                blogSettings: cmsStore.sanitizeBlogSettings(site.project.blog),
                note: 'Edits are drafts; cms_publish makes them live. Public URLs: /blog and /blog/<slug> (and /<locale>/blog/<slug> for a translation).',
            },
        };
    }

    /** @param {ToolArgs} args */
    async function getPost(args) {
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        const post = await findPost(site.siteId, args);
        if (!post) return notFoundHint(site.siteId, args);
        const all = (await cmsStore.collectPostLocaleOverrides(site.siteId, { fresh: true }))[post.id] || {};
        const wanted = typeof args.locale === 'string' && args.locale ? args.locale.toLowerCase() : null;
        const translations = wanted ? (all[wanted] ? { [wanted]: all[wanted] } : {}) : all;
        const warnings = postWarnings(post);
        return {
            result: {
                siteId: site.siteId,
                post: { ...shape(post, all), body: post.body },
                translations,
                defaultLocale: await cmsStore.getDefaultLocale(),
                ...(warnings.length ? { warnings } : {}),
            },
        };
    }

    const CREATE_FIELDS = new Set(['siteId', ...Object.keys(POST_PROPS)]);
    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function createPost(args, ctx) {
        const picked = pickFields(args, CREATE_FIELDS);
        if (picked.error) return picked.error;
        if (!picked.fields.title || !picked.fields.title.trim()) return err('title is required.');
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        if (!takeWriteBudget(ctx.userId)) return budgetSpent();
        let post;
        try { post = await cmsStore.createPost(site.siteId, picked.fields); } catch (e) { return storeError(e); }
        await deps.audit('cms.post.create.mcp', 'cms_post', post.id, ctx.userId, null, { tokenName: ctx.token?.name, siteId: site.siteId, slug: post.slug }, ctx.orgId || null);
        const warnings = postWarnings(post);
        return { result: { siteId: site.siteId, created: shape(post), ...(warnings.length ? { warnings } : {}), next: 'Look at it with cms_screenshot {postSlug}. It goes live with the next cms_publish (if its status is published or scheduled).' } };
    }

    const UPDATE_FIELDS = new Set(['siteId', 'postId', ...Object.keys(POST_PROPS), 'bodyEdits', 'appendBody']);
    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function updatePost(args, ctx) {
        const rest = { ...args };
        const edits = rest.bodyEdits;
        const append = rest.appendBody;
        delete rest.bodyEdits;
        delete rest.appendBody;
        const picked = pickFields(rest, UPDATE_FIELDS);
        if (picked.error) return picked.error;
        const fields = picked.fields;
        if (edits !== undefined && fields.body !== undefined) return err('Send either body (whole) or bodyEdits, not both.');
        if (append !== undefined && typeof append !== 'string') return err('appendBody must be Markdown text.');
        if (edits !== undefined) {
            if (!Array.isArray(edits) || !edits.length) return err('bodyEdits must be a non-empty list of {find, replace}.');
            if (edits.length > BODY_EDITS_MAX) return err(`At most ${BODY_EDITS_MAX} bodyEdits per call; split the work.`);
            for (const [i, e] of edits.entries()) {
                if (!isPlainObject(e) || typeof e.find !== 'string' || typeof e.replace !== 'string' || !e.find) {
                    return err(`bodyEdits[${i}] must be {find: non-empty text, replace: text}.`);
                }
                if (e.find.length > FIND_MAX_CHARS) return err(`bodyEdits[${i}].find is longer than ${FIND_MAX_CHARS} characters; send body whole instead.`);
            }
        }
        if (!Object.keys(fields).length && edits === undefined && append === undefined) {
            return err('Nothing to change.', { _fixHint: 'Pass at least one post field, bodyEdits or appendBody.' });
        }
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        const post = await findPost(site.siteId, { postId: args.postId });
        if (!post) return notFoundHint(site.siteId, args);

        let body = fields.body !== undefined ? fields.body : post.body || '';
        if (edits) {
            for (const [i, e] of edits.entries()) {
                const first = body.indexOf(e.find);
                if (first < 0) {
                    return err(`bodyEdits[${i}].find was not found in the body (nothing was changed).`, { _fixHint: 'Copy the exact text from cms_get_post, including punctuation and line breaks. Earlier edits in this call are applied first.' });
                }
                if (body.indexOf(e.find, first + 1) >= 0) {
                    return err(`bodyEdits[${i}].find occurs more than once (nothing was changed).`, { _fixHint: 'Include more surrounding text so it is unique.' });
                }
                body = body.slice(0, first) + e.replace + body.slice(first + e.find.length);
            }
        }
        if (append) body = `${body.replace(/\s+$/, '')}\n\n${append}`;
        if (edits || append !== undefined || fields.body !== undefined) fields.body = body;

        if (!takeWriteBudget(ctx.userId)) return budgetSpent();
        let saved;
        try { saved = await cmsStore.updatePost(site.siteId, post.id, fields); } catch (e) { return storeError(e); }
        const warnings = postWarnings(saved);
        return {
            result: {
                siteId: site.siteId,
                updated: shape(saved),
                changed: Object.keys(fields),
                ...(saved.slug !== post.slug ? { slugChanged: { from: post.slug, to: saved.slug } } : {}),
                ...(warnings.length ? { warnings } : {}),
            },
        };
    }

    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function deletePost(args, ctx) {
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        const post = await findPost(site.siteId, { postId: args.postId });
        if (!post) return notFoundHint(site.siteId, args);
        if (!takeWriteBudget(ctx.userId)) return budgetSpent();
        await cmsStore.deletePost(site.siteId, post.id);
        await deps.audit('cms.post.delete.mcp', 'cms_post', post.id, ctx.userId, null, { tokenName: ctx.token?.name, siteId: site.siteId, slug: post.slug }, ctx.orgId || null);
        return { result: { siteId: site.siteId, deleted: { id: post.id, slug: post.slug }, note: 'Removed from the draft; the live site drops it at the next cms_publish.' } };
    }

    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function setPostTranslation(args, ctx) {
        const locale = String(args.locale || '').toLowerCase();
        if (!cmsStore.isValidLocale(locale)) return err(`"${String(args.locale).slice(0, 20)}" is not a language code such as "nl".`);
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        if (locale === await cmsStore.getDefaultLocale()) {
            return err(`"${locale}" is the default language: edit the post itself with cms_update_post.`);
        }
        const post = await findPost(site.siteId, { postId: args.postId });
        if (!post) return notFoundHint(site.siteId, args);
        if (!takeWriteBudget(ctx.userId)) return budgetSpent();
        if (args.remove === true) {
            await cmsStore.deletePostLocaleOverride(site.siteId, post.id, locale);
            return { result: { siteId: site.siteId, postId: post.id, locale, removed: true } };
        }
        if (!isPlainObject(args.override)) return err('override must be an object {title, excerpt, body, coverAlt, seo}.');
        const allowed = new Set(['title', 'excerpt', 'body', 'coverAlt', 'seo']);
        const bad = Object.keys(args.override).filter(k => !allowed.has(k));
        if (bad.length) return err(`override has no field ${bad.slice(0, 5).join(', ')}.`, { _fixHint: 'Translatable: title, excerpt, body, coverAlt, seo {metaTitle, metaDescription}.' });
        let saved;
        try { saved = await cmsStore.setPostLocaleOverride(site.siteId, post.id, locale, args.override); } catch (e) { return storeError(e); }
        return { result: { siteId: site.siteId, postId: post.id, locale, saved: true, fields: Object.keys(saved).filter(k => k !== 'version'), path: `/${locale}/blog/${post.slug}` } };
    }

    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function updateBlogSettings(args, ctx) {
        const known = new Set(['siteId', 'title', 'description', 'postsPerPage']);
        const unknown = Object.keys(args).filter(k => !known.has(k));
        if (unknown.length) return err(`Unknown field: ${unknown.slice(0, 5).join(', ')}.`, { _fixHint: 'Send any of: title, description, postsPerPage.' });
        for (const k of ['title', 'description']) {
            if (args[k] !== undefined && (!isPlainObject(args[k]) || Object.keys(args[k]).length > 40)) {
                return err(`${k} must be an object of language code → text, e.g. {"en": "Blog", "nl": "Blog"}.`);
            }
        }
        if (args.postsPerPage !== undefined && (!Number.isInteger(args.postsPerPage) || args.postsPerPage < 1 || args.postsPerPage > 50)) {
            return err('postsPerPage must be a whole number from 1 to 50.');
        }
        if (args.title === undefined && args.description === undefined && args.postsPerPage === undefined) return err('Nothing to change.');
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        if (!takeWriteBudget(ctx.userId)) return budgetSpent();
        const merge = (/** @type {Record<string, string>} */ base, /** @type {Record<string, unknown> | undefined} */ patch) => {
            const out = { ...base };
            for (const [loc, v] of Object.entries(patch || {})) {
                if (typeof v !== 'string' || !v.trim()) delete out[loc];
                else out[loc] = v;
            }
            return out;
        };
        const { site: saved } = await cmsStore.mutateProject(site.siteId, (/** @type {Record<string, any>} */ project) => {
            const current = cmsStore.sanitizeBlogSettings(project.blog);
            project.blog = {
                title: merge(current.title, args.title),
                description: merge(current.description, args.description),
                postsPerPage: args.postsPerPage ?? current.postsPerPage,
            };
        }, { bumpRev: true });
        return { result: { siteId: site.siteId, blogSettings: saved.blog } };
    }

    return {
        handlers: {
            cms_list_posts: listPosts,
            cms_get_post: getPost,
            cms_create_post: createPost,
            cms_update_post: updatePost,
            cms_delete_post: deletePost,
            cms_set_post_translation: setPostTranslation,
            cms_update_blog_settings: updateBlogSettings,
        },
        _budget: budget,
    };
}

module.exports = { BLOG_TOOLS, createBlogHandlers, postWarnings, WRITE_MAX_PER_WINDOW, BODY_EDITS_MAX };
