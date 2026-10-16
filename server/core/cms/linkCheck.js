// @typecheck
/**
 * Link check of a CMS site draft: pure, no network and no store.
 *
 * Collects every link in the site chrome, the pages and the locale overrides
 * (link objects `{kind, ...}` and the plain URL strings of the cookie banner),
 * then checks the internal ones against the pages, posts and redirects of the
 * same site. External URLs are only collected here; core/cms/linkProbe.js is
 * what may ask the network about them, and only on an explicit action.
 */

'use strict';

const { RESERVED_TOP_LEVEL, LOCALE_PREFIXES, BLOG_BASE } = require('../../stores/cms/slugRules');
const { LEGAL_DOCS } = require('../seo/legalPaths');

/** More links than this in one site are not walked further. */
const MAX_LINKS = 5000;
/** Keys whose plain string value is a link target. */
const URL_KEYS = new Set(['privacyUrl', 'href', 'url']);
/** Files the public router serves besides pages. */
const STATIC_PATHS = new Set(['sitemap.xml', 'robots.txt', 'llms.txt', 'favicon.ico']);

/**
 * @typedef {object} Link
 * @property {string} where  readable location, e.g. "page home > blocks[2] > cta.link"
 * @property {'page' | 'path' | 'external'} type
 * @property {string} target a page id, a site path or an absolute URL
 */

/**
 * @typedef {object} Problem
 * @property {string} where
 * @property {string} url    as written, without query string or fragment
 * @property {string} code
 * @property {string} problem
 * @property {'error' | 'warning'} severity
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The URL without query string and fragment: safe to show, log and audit. */
function bareUrl(raw) {
    return String(raw).split('#')[0].split('?')[0].slice(0, 300);
}

/** @param {string} value @returns {Link['type'] | null} */
function typeOfString(value) {
    if (/^https?:\/\//i.test(value)) return 'external';
    if (value.startsWith('/') && !value.startsWith('//')) return 'path';
    return null;
}

/**
 * @param {unknown} node
 * @param {string} where
 * @param {Link[]} out
 */
function walk(node, where, out) {
    if (out.length >= MAX_LINKS) return;
    if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${where}[${i}]`, out));
        return;
    }
    if (!isObject(node)) return;
    let recognised = true;
    if (node.kind === 'page' && typeof node.pageId === 'string' && node.pageId) {
        out.push({ where, type: 'page', target: node.pageId });
    } else if (node.kind === 'external' && typeof node.url === 'string' && node.url.trim()) {
        out.push({ where, type: 'external', target: node.url.trim() });
    } else if (node.kind === 'app' && typeof node.path === 'string' && node.path.trim()) {
        out.push({ where, type: 'path', target: node.path.trim() });
    } else {
        recognised = false;
    }
    for (const [key, value] of Object.entries(node)) {
        const here = where ? `${where} > ${key}` : key;
        if (recognised && key === 'url') continue; // already taken as the link itself
        if (typeof value === 'string' && URL_KEYS.has(key)) {
            const type = typeOfString(value.trim());
            if (type) out.push({ where: here, type, target: value.trim() });
        } else {
            walk(value, here, out);
        }
    }
}

/**
 * Every link of a site payload (what cmsStore.getAdminPayload returns).
 * @param {{ site?: any, pages?: any[], localeOverrides?: { siteByLocale?: any, pagesByLocale?: any } }} payload
 * @returns {Link[]}
 */
function collectLinks(payload) {
    /** @type {Link[]} */
    const out = [];
    const site = payload.site || {};
    const slugOf = new Map((site.pages || []).map((p) => [p.id, p.slug || p.id]));
    const chrome = Object.fromEntries(Object.entries(site).filter(([key]) => key !== 'pages'));
    walk(chrome, 'site', out);
    for (const page of payload.pages || []) {
        walk(page && page.blocks, `page ${slugOf.get(page && page.id) || page?.id} > blocks`, out);
    }
    const overrides = payload.localeOverrides || {};
    for (const [locale, doc] of Object.entries(overrides.siteByLocale || {})) {
        walk(doc, `site (${locale})`, out);
    }
    for (const [pageId, perLocale] of Object.entries(overrides.pagesByLocale || {})) {
        for (const [locale, doc] of Object.entries(perLocale || {})) {
            walk(doc, `page ${slugOf.get(pageId) || pageId} (${locale})`, out);
        }
    }
    return out;
}

/**
 * Does a site path lead somewhere? Home, a page (also under a locale prefix),
 * a blog index or post, a redirect, an app route or a known static file.
 * @param {string} raw
 * @param {{ slugs: Set<string>, postSlugs: Set<string>, redirectFroms: Set<string> }} known
 * @returns {boolean}
 */
function pathResolves(raw, known) {
    const bare = bareUrl(raw).toLowerCase();
    let parts = bare.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    if (known.redirectFroms.has(`/${parts.join('/')}`)) return true;
    if (parts.length && LOCALE_PREFIXES.has(parts[0])) parts = parts.slice(1);
    if (!parts.length) return true;
    const [first, second] = parts;
    if (parts.length === 1 && STATIC_PATHS.has(first)) return true;
    if (first === BLOG_BASE) return parts.length === 1 || (parts.length === 2 && (second === 'feed.xml' || known.postSlugs.has(second)));
    if (first === 'legal' && parts.length === 2) return LEGAL_DOCS.includes(second) && known.slugs.has(second);
    if (known.slugs.has(first)) return parts.length === 1;
    return RESERVED_TOP_LEVEL.has(first);
}

/**
 * Check the internal links. External ones are returned as `external` for the
 * caller to probe (or not).
 * @param {Link[]} links
 * @param {{ pageIds: Set<string>, slugs: Set<string>, postSlugs: Set<string>, redirectFroms: Set<string> }} known
 * @returns {{ problems: Problem[], external: Link[], checked: number }}
 */
function checkInternalLinks(links, known) {
    /** @type {Problem[]} */
    const problems = [];
    /** @type {Link[]} */
    const external = [];
    let checked = 0;
    for (const link of links) {
        if (link.type === 'external') { external.push(link); continue; }
        checked++;
        if (link.type === 'page') {
            if (!known.pageIds.has(link.target)) {
                problems.push({ where: link.where, url: link.target, code: 'page_missing', severity: 'error', problem: 'The page this link points to no longer exists.' });
            }
        } else if (!pathResolves(link.target, known)) {
            problems.push({ where: link.where, url: bareUrl(link.target), code: 'path_not_found', severity: 'error', problem: 'No page, post or redirect answers at this address.' });
        }
    }
    return { problems, external, checked };
}

module.exports = { collectLinks, checkInternalLinks, pathResolves, bareUrl, MAX_LINKS };
