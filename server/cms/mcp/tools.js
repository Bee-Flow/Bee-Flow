/**
 * The tool surface of the CMS MCP server.
 *
 * Two sources, one list:
 *
 *   - the in-product CMS builder toolset (cmsBuilder/schemas.js: list site, get /
 *     create page, page meta and SEO, blocks, homepage, page order, header nav,
 *     design). Reused as they are — the same schemas, the same apply functions
 *     — with one optional `siteId` argument added, defaulting to the live site;
 *   - the MCP-only tools below, which cover the rest of the website: site
 *     settings (header, footer, cookie banner, announcement bar, analytics),
 *     translations, sites, templates, assets, uploads, screenshots, publishing.
 *
 * Each tool is classified once, here: read-only or not, and whether it is a
 * publish-class tool (publish and set-live), which needs the token's
 * `cms.publish` scope on top of the write level. The scope filter, the
 * annotations a client uses to ask before running something, and the dispatcher
 * all read this one table.
 */

'use strict';

const SITE_ID_PROP = Object.freeze({
    type: 'string',
    description: 'The site to act on (pj_… id from cms_list_sites). Omit it to use the live site.',
});

const LOCALE_PROP = Object.freeze({
    type: 'string',
    description: 'A language code such as "en", "nl" or "pt-br".',
});

/** Tools that act on no particular site, so they take no siteId. */
const SITELESS_TOOLS = new Set(['cms_list_sites', 'cms_list_templates', 'cms_list_assets', 'cms_upload_status']);

/** Publish-class tools: they change what visitors see. */
const PUBLISH_TOOLS = new Set(['cms_publish', 'cms_set_live_site']);

/**
 * @typedef {{ name: string, description: string, parameters: object,
 *             readOnly: boolean, publish?: boolean, destructive?: boolean }} McpOnlyTool
 */

/** @type {McpOnlyTool[]} */
const MCP_ONLY_TOOLS = [
    {
        name: 'cms_list_sites',
        description: 'List every site (id, name, version label, last change) and say which one is live. A site is a draft you edit; only the live site is served to visitors, and only after cms_publish. Start here to find the siteId.',
        parameters: { type: 'object', properties: {} },
        readOnly: true,
    },
    {
        name: 'cms_get_site_settings',
        description: 'Read the site-wide settings of a site: name, header (logo, buttons, nav), footer (columns, socials, copyright, accountability), cookie banner, announcement bar, analytics and the default language. Page content is read with cms_list_site / cms_get_page; the colours and fonts are in cms_list_site\'s design summary.',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                sections: {
                    type: 'array',
                    items: { type: 'string', enum: ['header', 'footer', 'cookieBanner', 'announcement', 'analytics'] },
                    description: 'Only these sections. Omit for all of them.',
                },
            },
        },
        readOnly: true,
    },
    {
        name: 'cms_update_site_settings',
        description: 'Change site-wide settings of the DRAFT. Each of header, footer, cookieBanner and announcement is a PATCH, deep-merged into what is there: objects merge key by key, arrays are replaced whole, so to change one footer column send the whole `columns` array. Read the current value with cms_get_site_settings first. The header MENU is cms_update_header_nav, not this tool. `analytics` takes {gaMeasurementId:"G-XXXXXXXXXX"} (empty string clears it). `name` renames the site. Page SEO is cms_update_page_seo. Links are objects: {kind:"page",pageId} | {kind:"external",url,newTab?} | {kind:"anchor",anchor} | {kind:"app",path}.',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                name: { type: 'string', description: 'New site name (max 200 chars).' },
                header: { type: 'object', description: 'Patch for the header (logoText, logo, ctas, enabled, …). Not nav.' },
                footer: { type: 'object', description: 'Patch for the footer (brandText, blurb, columns, socials, copyright, accountability, showLanguageSwitcher, …).' },
                cookieBanner: { type: 'object', description: 'Patch for the cookie banner (enabled, text per language).' },
                announcement: { type: 'object', description: 'Patch for the announcement bar (enabled, text per language, link, …).' },
                analytics: {
                    type: 'object',
                    properties: { gaMeasurementId: { type: 'string', description: 'Google Analytics 4 id like G-ABC123XYZ, or "" to clear.' } },
                },
            },
        },
        readOnly: false,
    },
    {
        name: 'cms_get_locale_overrides',
        description: 'Read the translations of a site: per language, the site-level overrides (header, footer, page titles) and, per page, the block texts and SEO text. Filter by pageId and/or locale to keep it small. The default language is not an override; it lives in the content itself.',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                pageId: { type: 'string', description: 'Only this page.' },
                locale: LOCALE_PROP,
            },
        },
        readOnly: true,
    },
    {
        name: 'cms_set_locale_override',
        description: 'Write the translation of the DRAFT for one language: a site-level override (omit pageId: {header, footer, pageTitles}) or a page-level one (pageId given: {blocks:{<blockId>:{…text fields only…}}, seo:{metaTitle,metaDescription}}). The override REPLACES the existing one for that language and scope, so read it with cms_get_locale_overrides first and send it whole. Text only: structure, icons, links and styles always come from the default language. Pass remove:true to delete the override.',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                locale: LOCALE_PROP,
                pageId: { type: 'string', description: 'Omit for the site-level override (header/footer/page titles).' },
                override: { type: 'object', description: 'The whole override object. Ignored when remove is true.' },
                remove: { type: 'boolean', description: 'Delete the override for this language and scope.' },
            },
            required: ['locale'],
        },
        readOnly: false,
        destructive: true,
    },
    {
        name: 'cms_delete_page',
        description: 'Delete a page from the DRAFT (not the live site until it is published). Cannot be undone. Links to it in the header and footer are removed; if it was the homepage, the first remaining page becomes the homepage (set another with cms_set_homepage).',
        parameters: {
            type: 'object',
            properties: { siteId: SITE_ID_PROP, pageId: { type: 'string', description: 'The page id (pg_…).' } },
            required: ['pageId'],
        },
        readOnly: false,
        destructive: true,
    },
    {
        name: 'cms_duplicate_site',
        description: 'Deep-copy a site (all pages, blocks, translations, settings) into a NEW draft version in the same version group. The copy is never live. Use it to try a redesign without touching the current draft; return the new siteId and work on that.',
        parameters: { type: 'object', properties: { siteId: SITE_ID_PROP } },
        readOnly: false,
    },
    {
        name: 'cms_list_templates',
        description: 'List the saved page templates (id, name, description, block count). Pass a template id as templateId to cms_create_page to seed a new page from it.',
        parameters: { type: 'object', properties: {} },
        readOnly: true,
    },
    {
        name: 'cms_list_assets',
        description: 'List the uploaded CMS assets (images, clips, captions), newest first, with the url to put in a block. If a file is not here, upload it: cms_request_upload.',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'integer', description: 'How many to return (1-200, default 100).' },
                search: { type: 'string', description: 'Only keys containing this text (case-insensitive).' },
            },
        },
        readOnly: true,
    },
    {
        name: 'cms_request_upload',
        description: 'Get a one-time upload URL for a LOCAL file (photo, video, SVG, captions). Allowed: jpeg, png, gif, webp, apng, svg, mp4, webm, vtt; images up to 25 MB, mp4/webm up to 500 MB, vtt up to 1 MB. The result holds a ready curl command: run it in a shell with the real file path. The file goes straight to the server and never through this conversation. The URL works once, for 15 minutes, for exactly this content type and size. The curl answer holds the asset `url` to use in a block; cms_upload_status reports it too. Do not paste file contents or base64 into any tool.',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                filename: { type: 'string', description: 'The file\'s name, e.g. "hero.jpg". Used to name the asset.' },
                contentType: { type: 'string', description: 'MIME type, e.g. "image/jpeg", "video/mp4", "image/svg+xml", "text/vtt".' },
                size: { type: 'integer', description: 'The file size in bytes (`stat -c %s file`). The upload may not exceed it.' },
            },
            required: ['filename', 'contentType', 'size'],
        },
        readOnly: false,
    },
    {
        name: 'cms_upload_status',
        description: 'Say what became of an upload URL: pending, uploading, done (with the asset url), failed or expired.',
        parameters: {
            type: 'object',
            properties: { ticketId: { type: 'string', description: 'The ticketId cms_request_upload returned.' } },
            required: ['ticketId'],
        },
        readOnly: true,
    },
    {
        name: 'cms_screenshot',
        description: 'Take a screenshot of a page, rendered like a visitor sees it, and LOOK at it. state "draft" shows your unpublished edits, "published" what is live. Pick the page by pageId or slug (omit both for the homepage). viewport desktop (1280 wide), tablet (834) or mobile (390). By default you get the top of the page; offsetY scrolls down by that many pixels, fullPage:true gives a scaled-down overview of the whole page. The result says whether the real site bundle rendered it or only the server markup. At most 24 per 10 minutes.',
        parameters: {
            type: 'object',
            properties: {
                siteId: SITE_ID_PROP,
                pageId: { type: 'string' },
                slug: { type: 'string', description: 'The page slug, e.g. "pricing". Empty = homepage.' },
                state: { type: 'string', enum: ['draft', 'published'], description: 'Default draft.' },
                locale: LOCALE_PROP,
                viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'], description: 'Default desktop.' },
                fullPage: { type: 'boolean', description: 'Whole page, scaled to fit (long pages become small).' },
                offsetY: { type: 'integer', description: 'Pixels from the top to start at (viewport-sized strip).' },
            },
        },
        readOnly: true,
    },
    {
        name: 'cms_publish',
        description: 'PUBLISH a site: freeze its current draft (pages, settings, translations) as the published snapshot. If the site is the live site, visitors see it from now on (cached copies can lag a few minutes). Needs the cms.publish scope on the token. Check the draft with cms_screenshot first.',
        parameters: { type: 'object', properties: { siteId: SITE_ID_PROP } },
        readOnly: false,
        publish: true,
    },
    {
        name: 'cms_set_live_site',
        description: 'Choose which site is served to visitors (only one is live at a time), or take the website offline with live:false. Going live publishes the site first if it never was. Needs the cms.publish scope on the token.',
        parameters: {
            type: 'object',
            properties: {
                siteId: { type: 'string', description: 'The site to make live (or to take offline when live is false).' },
                live: { type: 'boolean', description: 'true = serve this site, false = stop serving it. Default true.' },
            },
            required: ['siteId'],
        },
        readOnly: false,
        publish: true,
        destructive: true,
    },
];

/**
 * MCP tool descriptor from an OpenAI-shaped builder function, with `siteId`
 * spliced in. Copies: TOOL_SCHEMAS is shared with the in-product builder, whose
 * prompt cache depends on its bytes staying put.
 */
function toMcpTool(fn, { readOnly, destructive = false }) {
    const params = (fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object' };
    const takesSite = !SITELESS_TOOLS.has(fn.name);
    const properties = takesSite
        ? { siteId: SITE_ID_PROP, ...(params.properties || {}) }
        : { ...(params.properties || {}) };
    return {
        name: fn.name,
        description: fn.description || '',
        inputSchema: { ...params, type: 'object', properties },
        annotations: { title: fn.name, readOnlyHint: readOnly, destructiveHint: !readOnly && destructive },
    };
}

/**
 * The advertised list: builder tools first, then the MCP-only ones.
 * @param {{ TOOL_SCHEMAS: object[], MUTATING_TOOLS: Set<string> }} builder
 */
function buildToolList(builder) {
    const fromBuilder = builder.TOOL_SCHEMAS
        .map((t) => t.function)
        .filter(Boolean)
        .map((fn) => toMcpTool(fn, {
            readOnly: !builder.MUTATING_TOOLS.has(fn.name),
            destructive: /remove|delete/.test(fn.name),
        }));
    const own = MCP_ONLY_TOOLS.map((t) => toMcpTool(t, { readOnly: t.readOnly, destructive: !!t.destructive }));
    return [...fromBuilder, ...own];
}

module.exports = { MCP_ONLY_TOOLS, PUBLISH_TOOLS, SITELESS_TOOLS, SITE_ID_PROP, buildToolList, toMcpTool };
