// @typecheck
// Strict shape check for the site chrome a person SAVES: header, footer, cookie
// banner and announcement. sanitizeSite keeps those sections as long as they
// are plain objects, so a list stored as a string reached the public renderer
// and threw there. This is the gate on the two write paths that take chrome
// from outside (the admin site document and the MCP settings tool); it names
// the first wrong value and where it sits. Read paths never call it, so a
// site saved before the gate existed can still be opened and repaired.

const { COOKIE_BANNER_LAYOUTS } = require('../../i18n/defaults/cmsDefaults');

const LINK_KINDS = ['page', 'external', 'anchor', 'app'];
const LABEL_MAX = 200;
const URL_MAX = 2048;
const LIST_MAX = 100;

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Collects problems as `path: message` strings, stopping at the first.
 * @param {unknown} value
 * @param {string} path
 * @param {number} max
 * @returns {string | null}
 */
function textProblem(value, path, max) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return `${path} must be text.`;
    if (value.length > max) return `${path} is too long (max ${max} characters).`;
    return null;
}

/** @param {unknown} value @param {string} path @returns {string | null} */
function listProblem(value, path) {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) return `${path} must be a list.`;
    if (value.length > LIST_MAX) return `${path} has too many entries (max ${LIST_MAX}).`;
    return null;
}

/**
 * A link object { kind, ... }. Empty/absent is fine; a present one needs a known kind.
 * @param {string} path
 */
function linkProblem(link, path) {
    if (link === undefined || link === null) return null;
    if (!isObject(link)) return `${path} must be a link object.`;
    if (!LINK_KINDS.includes(link.kind)) {
        return `${path}.kind ${JSON.stringify(link.kind ?? null)} is not valid (use ${LINK_KINDS.join(', ')}).`;
    }
    return textProblem(link.url, `${path}.url`, URL_MAX)
        || textProblem(link.path, `${path}.path`, URL_MAX)
        || textProblem(link.anchor, `${path}.anchor`, URL_MAX)
        || textProblem(link.pageId, `${path}.pageId`, LABEL_MAX);
}

/**
 * Each entry of a list must be an object; `check` validates one entry.
 * @param {string} path
 */
function eachProblem(value, path, check) {
    const bad = listProblem(value, path);
    if (bad || !Array.isArray(value)) return bad;
    for (let i = 0; i < value.length; i++) {
        const entry = value[i];
        if (!isObject(entry)) return `${path}[${i}] must be an object.`;
        const problem = check(entry, `${path}[${i}]`);
        if (problem) return problem;
    }
    return null;
}

/** A labelled item with a link object (nav entries, header buttons). */
function linkedItem(item, path) {
    return textProblem(item.label, `${path}.label`, LABEL_MAX)
        || linkProblem(item.link, `${path}.link`)
        || textProblem(item.style, `${path}.style`, 40);
}

function navEntry(item, path) {
    const base = linkedItem(item, path);
    if (base) return base;
    const kids = eachProblem(item.children, `${path}.children`, linkedItem);
    if (kids) return kids;
    if (item.dropdown === undefined || item.dropdown === null) return null;
    if (!isObject(item.dropdown)) return `${path}.dropdown must be an object.`;
    return eachProblem(item.dropdown.columns, `${path}.dropdown.columns`, (col, colPath) =>
        textProblem(col.heading, `${colPath}.heading`, LABEL_MAX)
        || eachProblem(col.items, `${colPath}.items`, linkedItem));
}

function plainLink(item, path) {
    return textProblem(item.label, `${path}.label`, LABEL_MAX)
        || textProblem(item.href, `${path}.href`, URL_MAX)
        || linkProblem(item.link, `${path}.link`);
}

/** @param {Record<string, any>} header @returns {string | null} */
function headerProblem(header) {
    return textProblem(header.logoText, 'header.logoText', LABEL_MAX)
        || (header.logo != null && !isObject(header.logo) ? 'header.logo must be an object.' : null)
        || textProblem(header.logo?.text, 'header.logo.text', LABEL_MAX)
        || linkProblem(header.ctaLink, 'header.ctaLink')
        || eachProblem(header.ctas, 'header.ctas', linkedItem)
        || eachProblem(header.nav, 'header.nav', navEntry);
}

/** @param {Record<string, any>} footer @returns {string | null} */
function footerProblem(footer) {
    const acc = footer.accountability;
    return textProblem(footer.brandText, 'footer.brandText', LABEL_MAX)
        || textProblem(footer.blurb, 'footer.blurb', 2000)
        || textProblem(footer.copyright, 'footer.copyright', LABEL_MAX)
        || eachProblem(footer.columns, 'footer.columns', (col, colPath) =>
            textProblem(col.heading, `${colPath}.heading`, LABEL_MAX)
            || eachProblem(col.links, `${colPath}.links`, plainLink))
        || eachProblem(footer.socials, 'footer.socials', (s, sPath) =>
            textProblem(s.platform, `${sPath}.platform`, 40) || textProblem(s.href, `${sPath}.href`, URL_MAX)
            || linkProblem(s.link, `${sPath}.link`))
        || (acc != null && !isObject(acc) ? 'footer.accountability must be an object.' : null)
        || eachProblem(acc?.links, 'footer.accountability.links', plainLink);
}

/**
 * Banner and announcement: `text` is one blob per locale, `enabled` a flag.
 * @param {string} name
 */
function textBlobProblem(section, name) {
    if (section.enabled !== undefined && typeof section.enabled !== 'boolean') return `${name}.enabled must be true or false.`;
    if (section.text === undefined || section.text === null) return null;
    if (!isObject(section.text)) return `${name}.text must be an object with one entry per language.`;
    for (const [locale, copy] of Object.entries(section.text)) {
        if (!isObject(copy)) return `${name}.text.${locale} must be an object.`;
    }
    return null;
}

/** The cookie banner: a text blob plus a layout from the fixed set. */
function cookieBannerProblem(section) {
    const layout = section.layout;
    if (layout !== undefined && !COOKIE_BANNER_LAYOUTS.includes(layout)) {
        return `cookieBanner.layout must be one of ${COOKIE_BANNER_LAYOUTS.join(', ')}.`;
    }
    return textBlobProblem(section, 'cookieBanner');
}

/**
 * First problem in the chrome of a SiteDoc, as a sentence a person can act on,
 * or null when it is sound. Sections that are absent are fine (the defaults
 * fill them in); a section that is present must have the right shape.
 * @param {any} site
 * @returns {string | null}
 */
function validateSiteChrome(site) {
    if (!isObject(site)) return null;
    /** @type {[string, (s: Record<string, any>) => string | null][]} */
    const sections = [
        ['header', headerProblem],
        ['footer', footerProblem],
        ['cookieBanner', cookieBannerProblem],
        ['announcement', (s) => textBlobProblem(s, 'announcement')],
    ];
    for (const [name, check] of sections) {
        const section = site[name];
        if (section === undefined || section === null) continue;
        if (!isObject(section)) return `${name} must be an object.`;
        const problem = check(section);
        if (problem) return problem;
    }
    return null;
}

module.exports = { validateSiteChrome };
