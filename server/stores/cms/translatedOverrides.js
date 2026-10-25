// @typecheck strict
// Saving the result of an AI translation. The model call takes seconds and works
// on a snapshot of the content and of the stored override; meanwhile the editor may
// have reordered a list (which re-aligned the stored override). So the result is
// applied INSIDE the content lock, against a fresh read: re-aligned from the
// snapshot's item order to the current one when they differ, with the parked
// `_orphans` of the stored override win over the snapshot's copy.

const {
    isPlainObject, assertSiteId, pageKey, pageLocaleKey, projectKey, projectLocaleKey,
} = require('./shared');
const { withConfigGroup, realignRoot } = require('./overrideAlign');
const { sanitizePageOverride, sanitizeSiteOverride, assertLocale } = require('./localeOverrides');

/**
 * @param {string} siteId
 * @param {string} pageId
 * @param {string} locale
 * @param {any} result  the override the translation produced (aligned to `snapshotPage`)
 * @param {any} snapshotPage  the page the translation worked on
 * @returns {Promise<any>}  the override that was stored
 */
async function saveTranslatedPageOverride(siteId, pageId, locale, result, snapshotPage) {
    assertSiteId(siteId);
    assertLocale(locale);
    const key = pageLocaleKey(siteId, pageId, locale);
    return withConfigGroup(pageKey(siteId, pageId), async (io) => {
        const current = await io.get(pageKey(siteId, pageId));
        const stored = await io.get(key);
        const snapById = new Map((snapshotPage?.blocks || []).map((/** @type {any} */ b) => [b.id, b]));
        const currentById = new Map((current?.blocks || []).map((/** @type {any} */ b) => [b.id, b]));
        /** @type {Record<string, any>} */
        const blocks = {};
        for (const [blockId, blockOv] of Object.entries(isPlainObject(result?.blocks) ? result.blocks : {})) {
            const was = snapById.get(blockId);
            const now = currentById.get(blockId);
            if (current && !now) continue;   // the block was deleted meanwhile
            if (!isPlainObject(blockOv)) { blocks[blockId] = blockOv; continue; }
            const moved = was && now && JSON.stringify(was.content) !== JSON.stringify(now.content)
                ? realignRoot(blockOv, ['content'], () => was.content, () => now.content)
                : blockOv;
            const parked = stored?.blocks?.[blockId]?._orphans;
            blocks[blockId] = parked ? { ...moved, _orphans: parked } : moved;
        }
        const sanitized = sanitizePageOverride({ ...result, blocks });
        await io.set(key, sanitized);
        return sanitized;
    });
}

/**
 * @param {string} siteId
 * @param {string} locale
 * @param {any} result
 * @param {any} snapshotSite
 * @returns {Promise<any>}
 */
async function saveTranslatedSiteOverride(siteId, locale, result, snapshotSite) {
    assertSiteId(siteId);
    assertLocale(locale);
    const key = projectLocaleKey(siteId, locale);
    return withConfigGroup(projectKey(siteId), async (io) => {
        const current = await io.get(projectKey(siteId));
        const stored = await io.get(key);
        const aligned = isPlainObject(current) && isPlainObject(snapshotSite)
            ? realignRoot(result, ['header', 'footer'], (k) => snapshotSite[k], (k) => current[k])
            : result;
        const sanitized = sanitizeSiteOverride({ ...aligned, _orphans: stored?._orphans || aligned._orphans });
        await io.set(key, sanitized);
        return sanitized;
    });
}

module.exports = { saveTranslatedPageOverride, saveTranslatedSiteOverride };
