/**
 * Which languages a given page may be ADVERTISED in.
 *
 * This is a narrower question than "which languages does the site have", and
 * conflating the two is what breaks an hreflang cluster. `languageStore` seeds
 * en/nl/de/fr into every install, so `nl` is "available" on a site where not a
 * word has been translated. Emitting `hreflang="nl"` or a sitemap alternate on
 * that basis hands the crawler a /nl/ URL that serves English — and Google
 * treats a cluster whose alternates disagree with their declared language as
 * broken for every page in it, not just the offending one.
 *
 * So the rule here is: the default locale always, plus each locale this page
 * carries real translated text for.
 */

/**
 * Does a page-locale override actually contain a translation?
 *
 * The override is written as `{ version, blocks: {}, seo? }` and keeps that
 * shape after an editor opens a language and types nothing, so "the key exists"
 * is not the same as "there is Dutch on this page". Only real content counts —
 * an empty shell would re-introduce exactly the phantom alternates this module
 * exists to prevent.
 *
 * @param {object|null} override a page-locale override from the published snapshot
 * @returns {boolean}
 */
function hasTranslation(override) {
    if (!override || typeof override !== 'object') return false;
    const { blocks, seo } = override;
    if (blocks && typeof blocks === 'object' && Object.keys(blocks).length > 0) return true;
    return !!(seo && typeof seo === 'object'
        && Object.values(seo).some(v => String(v ?? '').trim() !== ''));
}

/**
 * The locales one page may be advertised in.
 *
 * @param {object|null} snapshot   published snapshot (carries pageLocaleOverrides)
 * @param {string} pageId
 * @param {string} defaultLocale
 * @param {string[]} siteLocaleList the site-wide list, default included
 * @returns {string[]} default locale first, then its real translations
 */
function localesForPage(snapshot, pageId, defaultLocale, siteLocaleList = []) {
    const forPage = (snapshot && snapshot.pageLocaleOverrides && snapshot.pageLocaleOverrides[pageId]) || {};
    return [
        defaultLocale,
        ...siteLocaleList.filter(loc => loc !== defaultLocale && hasTranslation(forPage[loc])),
    ];
}

module.exports = { hasTranslation, localesForPage };
