// @typecheck strict
/** @typedef {import('./blog').Post} Post */
const { safeUrl } = require('../../core/cms/blogMarkdown');

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

module.exports = { WRITE_WINDOW_MS, WRITE_MAX_PER_WINDOW, LIST_MAX, BODY_EDITS_MAX, FIND_MAX_CHARS, POST_PROPS, BLOG_TOOLS, isPlainObject, err, postWarnings, visibleNow };
