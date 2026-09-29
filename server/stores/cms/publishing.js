// @typecheck
// Publishing: snapshotting a project's entire current state into
// cms_published_{siteId}, and reading that snapshot back.

const crypto = require('crypto');
const configStore = require('../configStore');
const { getAll } = require('../../db');
const {
    KEY_LOCALE_INFIX, KEY_PAGE_INFIX, PUBLISHED_VERSION,
    isPlainObject, assertSiteId, projectKey, publishedKey,
} = require('./shared');
const { getProject } = require('./projects');
const { getPage } = require('./pages');
const log = require('../../telemetry/log');

// ── Publishing ───────────────────────────────────────────────────────
//
// Publishing snapshots the entire current state of a project (SiteDoc +
// every PageDoc + every locale override) into a single key:
//   cms_published_{siteId}
// The public /site route reads the snapshot when one exists, so admin
// edits stay invisible to visitors until the user clicks Publish again.
// Sites that have never been published serve their draft as before
// (caller falls back to getEffective).

async function getPublishedSnapshot(siteId, { fresh = false } = {}) {
    assertSiteId(siteId);
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const v = await read(publishedKey(siteId));
    return isPlainObject(v) ? v : null;
}

async function publishSite(siteId) {
    assertSiteId(siteId);
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');

    const pages = {};
    for (const entry of site.pages) {
        const page = await getPage(siteId, entry.id);
        if (page) pages[entry.id] = page;
    }

    // Intrinsic width/height for every image the snapshot serves — the
    // browser can only reserve layout space for dimensions it is told about,
    // and the editor never stores any. Publish is the one moment the server
    // holds the finished content AND the asset bytes, so the enrichment lands
    // here, in the snapshot (the draft stays untouched). Best-effort by
    // design: a publish must never fail over an unreadable image.
    try {
        const { enrichMediaDims, makeStorageProbe } = require('../../utils/mediaDims');
        const storageStore = require('../storageStore');
        await enrichMediaDims(pages, makeStorageProbe(storageStore));
    } catch (e) {
        log.warn('[CMS] publish media-dims enrichment skipped:', e.message);
    }

    const allLocaleKeys = await getAll(
        `SELECT key FROM config WHERE key LIKE $1`,
        [`${projectKey(siteId)}%${KEY_LOCALE_INFIX}%`]
    );
    const siteLocaleOverrides = {};
    const pageLocaleOverrides = {};
    for (const r of allLocaleKeys) {
        const tail = r.key.substring(projectKey(siteId).length);
        if (tail.startsWith(KEY_PAGE_INFIX)) {
            const inner = tail.substring(KEY_PAGE_INFIX.length);
            const splitAt = inner.indexOf(KEY_LOCALE_INFIX);
            if (splitAt < 0) continue;
            const pageId = inner.substring(0, splitAt);
            const locale = inner.substring(splitAt + KEY_LOCALE_INFIX.length);
            pageLocaleOverrides[pageId] = pageLocaleOverrides[pageId] || {};
            pageLocaleOverrides[pageId][locale] = await configStore.getConfig(r.key);
        } else if (tail.startsWith(KEY_LOCALE_INFIX)) {
            const locale = tail.substring(KEY_LOCALE_INFIX.length);
            siteLocaleOverrides[locale] = await configStore.getConfig(r.key);
        }
    }

    /* Per-page lastmod, for the sitemap. Before this, `publishedAt` stamped
       every URL, so one publish reset the <lastmod> of every page at once —
       a crawler could never tell an edited page from an untouched one. The
       hash covers the page doc (post-enrichment, i.e. what is actually
       served) plus its locale overrides; site chrome deliberately does not
       participate — a nav edit is not a page edit. Snapshots that pre-date
       `pageMeta` get their hashes recomputed from their own pages, so even
       the first publish after this change carries dates over instead of
       resetting all of them. Additive field: PUBLISHED_VERSION stays put and
       every reader uses optional chaining. */
    const prev = await getPublishedSnapshot(siteId, { fresh: true });
    const publishedAt = new Date().toISOString();
    const pageHash = (page, overrides) => crypto.createHash('sha256')
        .update(JSON.stringify({ page, overrides: overrides || null }))
        .digest('hex');
    const prevMetaFor = (id) => {
        const stored = prev?.pageMeta?.[id];
        if (stored?.hash) return stored;
        if (!prev?.pages?.[id]) return null;
        return {
            hash: pageHash(prev.pages[id], prev.pageLocaleOverrides?.[id]),
            lastModifiedAt: prev.publishedAt || null,
        };
    };
    const pageMeta = {};
    for (const id of Object.keys(pages)) {
        const hash = pageHash(pages[id], pageLocaleOverrides[id]);
        const before = prevMetaFor(id);
        pageMeta[id] = {
            hash,
            lastModifiedAt: (before && before.hash === hash && before.lastModifiedAt)
                ? before.lastModifiedAt
                : publishedAt,
        };
    }

    const snapshot = {
        version: PUBLISHED_VERSION,
        publishedAt,
        site,
        pages,
        pageMeta,
        siteLocaleOverrides,
        pageLocaleOverrides,
    };
    await configStore.setConfig(publishedKey(siteId), snapshot);
    return { publishedAt: snapshot.publishedAt };
}

module.exports = { getPublishedSnapshot, publishSite };
