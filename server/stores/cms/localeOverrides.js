// @typecheck
// The CMS translation layer: the org-wide default locale, the per-locale
// override rows for site chrome and page blocks, and the bulk readers that
// collect every override for one site or prune one block's out of all of them.

const configStore = require('../configStore');
const { getAll } = require('../../db');
const {
    KEY_DEFAULT_LOCALE, KEY_LOCALE_INFIX, KEY_PAGE_INFIX, LOCALE_OVERRIDE_VERSION,
    isPlainObject, assertSiteId,
    projectKey, projectLocaleKey, pageKey, pageLocaleKey,
} = require('./shared');

// ── Locale settings (org-wide) ───────────────────────────────────────

// This value is spliced into <html lang> on every server-rendered marketing
// page (core/seo/inject.js), so it is checked on the way IN and distrusted on
// the way OUT: a row written before this check existed must not keep
// rendering. Lowercase because putDefaultLocale normalises before storing.
const LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

function isValidLocale(code) {
    return typeof code === 'string' && LOCALE_RE.test(code);
}

async function getDefaultLocale({ fresh = false } = {}) {
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const v = await read(KEY_DEFAULT_LOCALE);
    return isValidLocale(v) ? v : 'en';
}
async function setDefaultLocale(locale) {
    if (!locale || typeof locale !== 'string') throw new Error('Locale required');
    const code = locale.trim().toLowerCase();
    if (!isValidLocale(code)) throw new Error('Invalid locale');
    await configStore.setConfig(KEY_DEFAULT_LOCALE, code);
}

// ── Site-locale overrides (header/footer text per locale) ────────────

async function getSiteLocaleOverride(siteId, locale, { fresh = false } = {}) {
    assertSiteId(siteId);
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const v = await read(projectLocaleKey(siteId, locale));
    return isPlainObject(v) ? v : null;
}
async function setSiteLocaleOverride(siteId, locale, override) {
    assertSiteId(siteId);
    if (!locale) throw new Error('Locale required');
    if (!isPlainObject(override)) throw new Error('Override must be an object');
    const sanitized = {
        version: LOCALE_OVERRIDE_VERSION,
        header:     isPlainObject(override.header) ? override.header : undefined,
        footer:     isPlainObject(override.footer) ? override.footer : undefined,
        pageTitles: isPlainObject(override.pageTitles) ? override.pageTitles : undefined,
    };
    await configStore.setConfig(projectLocaleKey(siteId, locale), sanitized);
}
async function deleteSiteLocaleOverride(siteId, locale) {
    assertSiteId(siteId);
    await configStore.deleteConfig(projectLocaleKey(siteId, locale));
}

async function getPageLocaleOverride(siteId, pageId, locale, { fresh = false } = {}) {
    assertSiteId(siteId);
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const v = await read(pageLocaleKey(siteId, pageId, locale));
    return isPlainObject(v) ? v : null;
}
async function setPageLocaleOverride(siteId, pageId, locale, override) {
    assertSiteId(siteId);
    if (!pageId) throw new Error('pageId required');
    if (!locale) throw new Error('Locale required');
    if (!isPlainObject(override)) throw new Error('Override must be an object');
    const sanitized = {
        version: LOCALE_OVERRIDE_VERSION,
        blocks: isPlainObject(override.blocks) ? override.blocks : {},
    };
    // SEO meta translations (metaTitle / metaDescription) live alongside the
    // block overrides on the page-locale key. Strings only — anything else is
    // dropped so the override stays a pure text patch.
    if (isPlainObject(override.seo)) {
        const seo = {};
        if (typeof override.seo.metaTitle === 'string') seo.metaTitle = override.seo.metaTitle;
        if (typeof override.seo.metaDescription === 'string') seo.metaDescription = override.seo.metaDescription;
        if (Object.keys(seo).length) sanitized.seo = seo;
    }
    await configStore.setConfig(pageLocaleKey(siteId, pageId, locale), sanitized);
}
async function deletePageLocaleOverride(siteId, pageId, locale) {
    assertSiteId(siteId);
    await configStore.deleteConfig(pageLocaleKey(siteId, pageId, locale));
}

/**
 * Every locale override belonging to one site, in one pass.
 *
 * The like-pattern matches both site-locale and page-locale rows; they're
 * told apart by the `_page_` infix. Shared by getAdminPayload (editor
 * state), exportSite and duplicateProject so the three can never disagree
 * about what "all translations" means.
 */
async function collectLocaleOverrides(siteId, { fresh = false } = {}) {
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const rows = await getAll(
        `SELECT key FROM config WHERE key LIKE $1`,
        [`${projectKey(siteId)}%${KEY_LOCALE_INFIX}%`]
    );
    const siteByLocale = {};
    const pagesByLocale = {};
    for (const r of rows) {
        // tail is one of:
        //   _locale_{xx}                 → site-locale override
        //   _page_{pageId}_locale_{xx}   → page-locale override
        const tail = r.key.substring(projectKey(siteId).length);
        if (tail.startsWith(KEY_PAGE_INFIX)) {
            const inner = tail.substring(KEY_PAGE_INFIX.length);
            const splitAt = inner.indexOf(KEY_LOCALE_INFIX);
            if (splitAt < 0) continue;
            const pageId = inner.substring(0, splitAt);
            const locale = inner.substring(splitAt + KEY_LOCALE_INFIX.length);
            pagesByLocale[pageId] = pagesByLocale[pageId] || {};
            pagesByLocale[pageId][locale] = await read(r.key);
        } else if (tail.startsWith(KEY_LOCALE_INFIX)) {
            siteByLocale[tail.substring(KEY_LOCALE_INFIX.length)] = await read(r.key);
        }
    }
    return { siteByLocale, pagesByLocale };
}

/**
 * Delete every locale override for ONE block on a page — the server twin of
 * the client-side pruning the admin panel does when a block is removed.
 * Locale overrides are keyed by block id, so a removed block would otherwise
 * leave orphaned translation entries behind on every locale. Idempotent;
 * returns the list of locales that were actually pruned.
 */
async function pruneBlockLocaleOverrides(siteId, pageId, blockId) {
    assertSiteId(siteId);
    if (!pageId || !blockId) return [];
    const rows = await getAll(
        `SELECT key FROM config WHERE key LIKE $1`,
        [`${pageKey(siteId, pageId)}${KEY_LOCALE_INFIX}%`]
    );
    const pruned = [];
    for (const r of rows) {
        const override = await configStore.getConfigFresh(r.key);
        if (!isPlainObject(override) || !isPlainObject(override.blocks)) continue;
        if (!Object.prototype.hasOwnProperty.call(override.blocks, blockId)) continue;
        const blocks = { ...override.blocks };
        delete blocks[blockId];
        await configStore.setConfig(r.key, { ...override, blocks });
        pruned.push(r.key.substring(r.key.lastIndexOf(KEY_LOCALE_INFIX) + KEY_LOCALE_INFIX.length));
    }
    return pruned;
}

module.exports = {
    isValidLocale, getDefaultLocale, setDefaultLocale,
    getSiteLocaleOverride, setSiteLocaleOverride, deleteSiteLocaleOverride,
    getPageLocaleOverride, setPageLocaleOverride, deletePageLocaleOverride,
    collectLocaleOverrides, pruneBlockLocaleOverrides,
};
