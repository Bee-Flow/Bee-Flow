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

const { safeUrl, sanitizeMediaRef } = require('../../core/cms/blogMarkdown');

/**
 * @typedef {import('./handlerKit').ToolArgs} ToolArgs
 * @typedef {import('./handlerKit').McpCtx} McpCtx
 * @typedef {Record<string, any>} Post  one blog post as the store holds it
 */

const SITE_ID_PROP = Object.freeze({
    type: 'string',
    description: 'The site to act on (pj_… id from cms_list_sites). Omit it to use the live site.',
});

const WRITE_WINDOW_MS = 10 * 60 * 1000;
const WRITE_MAX_PER_WINDOW = 120;
const LIST_MAX = 100;
const BODY_EDITS_MAX = 20;
const FIND_MAX_CHARS = 5000;

const POST_FIELDS_DOC = 'Fields: title (≤200), slug (lowercase letters, digits, dashes; made unique, derived from the title when omitted), excerpt (≤500, the teaser on the index and the meta description fallback), body (Markdown, ≤100000 characters: ## headings, **bold**, lists, > quotes, `code`, tables, [links](https://…) and images ![alt](url) where url is an asset url from cms_list_assets / cms_request_upload), coverImage (asset url or https URL), coverAlt (describe the image), authorName (free-text display name, not an account), tags (≤10 short words), status ("draft" | "scheduled" | "published"), publishedAt (ISO date; required for scheduled, defaults to now for published), seo {metaTitle, metaDescription, ogImage, noIndex}.';

const POST_PROPS = {
    title: { type: 'string', description: 'The post title (also the page <h1>).' },
    slug: { type: 'string', description: 'URL part after /blog/. Omit to derive it from the title.' },
    excerpt: { type: 'string', description: 'One or two sentences shown on the blog index and in search results.' },
    body: { type: 'string', description: 'The whole post as Markdown. Use ## for sections (the title is already the h1).' },
    coverImage: { type: 'string', description: 'Cover image: an asset url (/api/cms/asset/cms/…) or an https URL.' },
    coverAlt: { type: 'string', description: 'Alt text for the cover image.' },
    authorName: { type: 'string', description: 'Author name as shown on the post. Free text; never put an e-mail address here.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Up to 10 tags, e.g. ["product", "privacy"].' },
    status: { type: 'string', enum: ['draft', 'scheduled', 'published'], description: 'draft = hidden; scheduled = visible from publishedAt; published = visible (after cms_publish).' },
    publishedAt: { type: 'string', description: 'ISO date-time, e.g. 2026-11-03T09:00:00Z. Required for scheduled.' },
    seo: {
        type: 'object',
        description: 'Search/social overrides. Patch: only the keys you send change.',
        properties: {
            metaTitle: { type: 'string' }, metaDescription: { type: 'string' },
            ogImage: { type: 'string' }, noIndex: { type: 'boolean' },
        },
    },
};

/** @type {import('./tools').McpOnlyTool[]} */
const BLOG_TOOLS = [
    {
        name: 'cms_list_posts',
        description: 'List the blog posts of a site, newest first: id, slug, title, status, publishedAt, tags, excerpt, which languages are translated, and whether visitors can see it now. Filter by status, tag or a search word. Bodies are not included (cms_get_post). The public blog is /blog, a post /blog/<slug>.',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                status: { type: 'string', enum: ['draft', 'scheduled', 'published'] },
                tag: { type: 'string', description: 'Only posts with this tag.' },
                search: { type: 'string', description: 'Only posts whose title, slug or excerpt contains this text.' },
                limit: { type: 'integer', description: `How many (1-${LIST_MAX}, default 50).` },
                offset: { type: 'integer', description: 'Skip this many (paging).' },
            },
        },
        readOnly: true,
    },
    {
        name: 'cms_get_post',
        description: 'Read one blog post in full (Markdown body, SEO, status, dates) by postId or slug, plus its translations. Pass locale to get only that language\'s translation.',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                postId: { type: 'string', description: 'The post id (po_…).' },
                slug: { type: 'string', description: 'The post slug, instead of postId.' },
                locale: { type: 'string', description: 'Only this language\'s translation, e.g. "nl".' },
            },
        },
        readOnly: true,
    },
    {
        name: 'cms_create_post',
        description: `Create a blog post in the DRAFT of a site. Only title is required. ${POST_FIELDS_DOC} A new post is a draft unless you set status. Visitors see it only after cms_publish. Check it with cms_screenshot {postSlug}.`,
        parameters: { type: 'object', properties: { siteId: SITE_ID_PROP, ...POST_PROPS }, required: ['title'] },
        readOnly: false,
    },
    {
        name: 'cms_update_post',
        description: `Change a blog post (draft). Send only what changes; seo is merged key by key. ${POST_FIELDS_DOC} Body: either "body" (replaces it whole), or "bodyEdits" [{find, replace}] for small edits — each find must occur EXACTLY ONCE in the current body (copy it from cms_get_post; include enough context to be unique), up to ${BODY_EDITS_MAX} edits applied in order — and/or "appendBody" (Markdown added at the end). Changing slug changes the URL.`,
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                postId: { type: 'string', description: 'The post id (po_…).' },
                ...POST_PROPS,
                bodyEdits: {
                    type: 'array',
                    description: 'Exact find/replace edits on the current Markdown body.',
                    items: {
                        type: 'object',
                        properties: { find: { type: 'string' }, replace: { type: 'string' } },
                        required: ['find', 'replace'],
                    },
                },
                appendBody: { type: 'string', description: 'Markdown appended to the end of the body (after a blank line).' },
            },
            required: ['postId'],
        },
        readOnly: false,
    },
    {
        name: 'cms_delete_post',
        description: 'Delete a blog post and its translations from the DRAFT. Cannot be undone. The live site still shows it until the next cms_publish.',
        parameters: {
            type: 'object',
            properties: { siteId: SITE_ID_PROP, postId: { type: 'string', description: 'The post id (po_…).' } },
            required: ['postId'],
        },
        readOnly: false,
        destructive: true,
    },
    {
        name: 'cms_set_post_translation',
        description: 'Write the translation of a blog post for one language (not the default language): {title, excerpt, body (Markdown), coverAlt, seo:{metaTitle, metaDescription}}. It REPLACES the existing translation for that language, so read it with cms_get_post {locale} first and send it whole. Empty fields fall back to the original text. Slug, tags, images and dates are never translated. remove:true deletes the translation. A translated post is served at /<locale>/blog/<slug>.',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                postId: { type: 'string', description: 'The post id (po_…).' },
                locale: { type: 'string', description: 'A language code such as "nl".' },
                override: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' }, excerpt: { type: 'string' }, body: { type: 'string' }, coverAlt: { type: 'string' },
                        seo: { type: 'object', properties: { metaTitle: { type: 'string' }, metaDescription: { type: 'string' } } },
                    },
                },
                remove: { type: 'boolean', description: 'Delete this language\'s translation.' },
            },
            required: ['postId', 'locale'],
        },
        readOnly: false,
        destructive: true,
    },
    {
        name: 'cms_update_blog_settings',
        description: 'Set the blog index of a site (draft): its heading and intro per language, e.g. title {"en":"Blog","nl":"Blog"}, description {"en":"News from the team","nl":"Nieuws van het team"}, and postsPerPage (1-50, default 10). Each of title/description is merged per language; an empty string clears that language. Read the current values with cms_list_posts (blogSettings).',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                title: { type: 'object', description: 'Heading per language code.' },
                description: { type: 'object', description: 'Intro text per language code.' },
                postsPerPage: { type: 'integer' },
            },
        },
        readOnly: false,
    },
];

/** @param {unknown} v */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 */
const err = (error, extra = {}) => ({ result: { error, ...extra } });

/**
 * Advice an agent can act on: what the post is missing or what will not render.
 * @param {Post} post
 */
function postWarnings(post) {
    /** @type {string[]} */
    const out = [];
    if (!post.excerpt) out.push('No excerpt: the index and search results use the first lines of the body instead. Set excerpt for a better teaser.');
    if (post.coverImage && !post.coverAlt) out.push('The cover image has no coverAlt; describe it for screen readers.');
    if (!post.body || !post.body.trim()) out.push('The body is empty.');
    if ((post.seo?.metaDescription || post.excerpt || '').length > 155) out.push('The description is longer than 155 characters; search engines cut it off.');
    if ((post.seo?.metaTitle || post.title || '').length > 60) out.push('The title is longer than 60 characters; set seo.metaTitle for search results.');
    /** @type {string[]} */
    const dropped = [];
    const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
    /** @type {RegExpExecArray | null} */
    let m;
    while ((m = re.exec(post.body || '')) && dropped.length < 5) {
        const isImage = m[0].startsWith('!');
        if (!safeUrl(m[1], { kind: isImage ? 'image' : 'link' })) dropped.push(m[1].slice(0, 60));
    }
    if (dropped.length) out.push(`These URLs are not allowed and will render as plain text: ${dropped.join(', ')}. Use https://, a /path on this site, #anchor, mailto: (links) or an asset url.`);
    if (/<\/?[a-z][^>]*>/i.test(post.body || '')) out.push('The body contains HTML tags; they are shown as text, not rendered. Use Markdown instead.');
    if (post.status === 'scheduled' && Date.parse(post.publishedAt || '') <= Date.now()) out.push('publishedAt is in the past, so this "scheduled" post is visible as soon as the site is published.');
    return out;
}

/**
 * @param {Post} post
 * @param {number} now
 */
function visibleNow(post, now) {
    if (post.status !== 'published' && post.status !== 'scheduled') return false;
    const t = Date.parse(post.publishedAt || '');
    return Number.isFinite(t) && t <= now;
}

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

    const storeError = (/** @type {any} */ e) => {
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
        if (site.error) return err(site.error);
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
        if (site.error) return err(site.error);
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
        if (site.error) return err(site.error);
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
        if (site.error) return err(site.error);
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
        if (site.error) return err(site.error);
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
        if (site.error) return err(site.error);
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
        if (site.error) return err(site.error);
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
