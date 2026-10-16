// @typecheck
// Redirects of one site: the manual list and the automatic 301 a slug change
// leaves behind. Own config key (cms_project_{siteId}_redirects), not a field
// of the SiteDoc: the admin editor saves the whole SiteDoc, and a stale copy of
// it must never be able to wipe the list. The rules (loops, chains, targets)
// are stores/cms/redirectRules.js; this file only stores the result.

const configStore = require('../configStore');
const log = require('../../telemetry/log');
const rules = require('./redirectRules');
const { assertSiteId, isPlainObject, redirectsKey } = require('./shared');
const { getDefaultLocale, collectLocaleOverrides } = require('./localeOverrides');

/** @typedef {import('./redirectRules').Redirect} Redirect */
/** @typedef {{ redirects: Redirect[], allowedHosts: string[] }} RedirectDoc */

/** @param {unknown} v @returns {RedirectDoc} */
function normalizeDoc(v) {
    const src = isPlainObject(v) ? /** @type {Record<string, unknown>} */ (v) : {};
    const hosts = rules.sanitizeHosts(src.allowedHosts);
    return { redirects: rules.sanitizeRedirects(src.redirects, hosts), allowedHosts: hosts };
}

/** @param {string} siteId @param {{ fresh?: boolean }} [opts] @returns {Promise<RedirectDoc>} */
async function getRedirects(siteId, { fresh = false } = {}) {
    assertSiteId(siteId);
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    return normalizeDoc(await read(redirectsKey(siteId)));
}

/**
 * Atomic read-modify-write; the mutator gets the current document and returns
 * the next one (it may throw a RedirectError to refuse).
 * @param {string} siteId
 * @param {(doc: RedirectDoc) => RedirectDoc} mutator
 * @returns {Promise<RedirectDoc>}
 */
async function mutate(siteId, mutator) {
    assertSiteId(siteId);
    return configStore.mutateConfig(redirectsKey(siteId), (cur) => {
        const next = mutator(normalizeDoc(cur));
        return normalizeDoc(next);
    });
}

/**
 * Add or replace one redirect. Throws a RedirectError (loop, bad target, ...).
 * @param {string} siteId
 * @param {{ from: unknown, to: unknown, status?: unknown, external?: unknown }} input
 * @returns {Promise<{ entry: Redirect, redirects: Redirect[] }>}
 */
async function setRedirect(siteId, input) {
    /** @type {Redirect | undefined} */
    let entry;
    const { siteByLocale, pagesByLocale } = await collectLocaleOverrides(siteId, { fresh: true });
    const locales = [await getDefaultLocale(), ...Object.keys(siteByLocale || {}), ...Object.values(pagesByLocale || {}).flatMap((o) => Object.keys(o || {}))];
    const doc = await mutate(siteId, (cur) => {
        const redirects = rules.addRedirect(cur.redirects, { ...input, auto: false }, { allowedHosts: cur.allowedHosts, locales });
        entry = redirects.find((r) => r.from === rules.normalizeFrom(input.from, locales));
        return { ...cur, redirects };
    });
    return { entry: /** @type {Redirect} */ (entry), redirects: doc.redirects };
}

/** @returns {Promise<boolean>} whether an entry was removed */
async function removeRedirect(siteId, id) {
    let removed = false;
    await mutate(siteId, (cur) => {
        const redirects = cur.redirects.filter((r) => r.id !== id);
        removed = redirects.length !== cur.redirects.length;
        return { ...cur, redirects };
    });
    return removed;
}

/**
 * Replace the external-host allow-list. Entries whose host is no longer
 * allowed are dropped by the re-sanitize in `mutate`.
 * @param {string} siteId @param {unknown} hosts
 */
async function setAllowedHosts(siteId, hosts) {
    return mutate(siteId, (cur) => ({ ...cur, allowedHosts: rules.sanitizeHosts(hosts) }));
}

/**
 * A page was renamed: leave a 301 from its old URL, and free the new URL of
 * any redirect that used to live there (the page owns it now). Never throws:
 * a redirect problem must not fail a rename.
 * @param {string} siteId @param {string} oldSlug @param {string} newSlug
 */
async function recordRename(siteId, oldSlug, newSlug) {
    const input = rules.renameRedirect(oldSlug, newSlug);
    if (!input) return;
    try {
        await mutate(siteId, (cur) => {
            const free = cur.redirects.filter((r) => r.from !== `/${newSlug}`);
            return { ...cur, redirects: rules.addRedirect(free, input, { allowedHosts: cur.allowedHosts }) };
        });
    } catch (e) {
        log.warn(`[CMS] no automatic redirect for ${oldSlug} -> ${newSlug}: ${e.message}`);
    }
}

/**
 * A page was deleted and the editor chose where its address should lead.
 * The page is already gone, so a refusal is reported, not thrown.
 * @param {string} siteId @param {string} slug @param {string} to
 * @returns {Promise<{ entry?: Redirect, error?: string }>}
 */
async function redirectDeleted(siteId, slug, to) {
    try {
        const { entry } = await setRedirect(siteId, { from: `/${slug}`, to });
        return { entry };
    } catch (e) {
        if (e instanceof rules.RedirectError) return { error: e.message };
        throw e;
    }
}

/**
 * A page now owns `slug`: a redirect from that address would shadow it.
 * @param {string} siteId @param {string} slug
 */
async function releaseSlug(siteId, slug) {
    const doc = await getRedirects(siteId, { fresh: true });
    if (!doc.redirects.some((r) => r.from === `/${slug}`)) return;
    await mutate(siteId, (cur) => ({ ...cur, redirects: cur.redirects.filter((r) => r.from !== `/${slug}`) }));
}

/**
 * Replace the whole document (duplicate, import).
 * @param {string} siteId @param {unknown} doc
 */
async function restoreRedirects(siteId, doc) {
    assertSiteId(siteId);
    const clean = normalizeDoc(doc);
    if (!clean.redirects.length && !clean.allowedHosts.length) return clean;
    await configStore.setConfig(redirectsKey(siteId), clean);
    return clean;
}

module.exports = {
    getRedirects, setRedirect, removeRedirect, setAllowedHosts,
    recordRename, releaseSlug, restoreRedirects, redirectDeleted,
};
