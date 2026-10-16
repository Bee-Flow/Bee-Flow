// @typecheck
// Publishing: snapshotting a project's entire current state into
// cms_published_{siteId}, and reading that snapshot back.

const crypto = require('crypto');
const configStore = require('../configStore');
const { getAll } = require('../../db');
const {
    KEY_LOCALE_INFIX, KEY_PAGE_INFIX, PUBLISHED_VERSION,
    isPlainObject, assertSiteId, projectKey, pageKey, publishedKey,
} = require('./shared');
const { migrateSite } = require('./siteDoc');
const { listPosts, collectPostLocaleOverrides } = require('./posts');
const { getRedirects } = require('./redirects');
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

/**
 * Parse a raw `config.value` the way configStore does: JSON, else the text.
 * @param {string} raw
 */
function parseStored(raw) {
    try { return JSON.parse(raw); } catch (_) { return raw; }
}

/**
 * A LIKE pattern for "starts with `prefix`": `_`, `%` and `\` in the prefix
 * (the key infixes contain underscores) match themselves, not any character.
 * @param {string} prefix
 */
function likePrefix(prefix) {
    return `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
}

async function publishSite(siteId) {
    assertSiteId(siteId);

    // ONE statement reads the site doc, every page and every locale override:
    // a single MVCC snapshot straight from the database, so a publish can
    // neither serve this replica's stale cache nor mix versions (key list from
    // SQL but values from a cache, or a page saved halfway through the loop).
    const base = projectKey(siteId);
    const rows = await getAll(
        `SELECT key, value FROM config WHERE key = $1 OR key LIKE $2 ESCAPE '\\' OR key LIKE $3 ESCAPE '\\'`,
        [base, likePrefix(`${base}${KEY_PAGE_INFIX}`), likePrefix(`${base}${KEY_LOCALE_INFIX}`)]
    );
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const rawSite = stored.has(base) ? parseStored(stored.get(base)) : null;
    if (!isPlainObject(rawSite)) throw new Error('Project not found');
    const site = migrateSite(structuredClone(rawSite));

    const pages = {};
    for (const entry of site.pages) {
        const raw = stored.has(pageKey(siteId, entry.id)) ? parseStored(stored.get(pageKey(siteId, entry.id))) : null;
        // The editing revision is not content: leaving it out keeps the
        // published page (and its sitemap lastmod hash) the same across
        // saves that changed nothing a visitor sees.
        if (isPlainObject(raw)) { const { rev: _rev, ...content } = raw; pages[entry.id] = content; }
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

    const siteLocaleOverrides = {};
    const pageLocaleOverrides = {};
    for (const [key, raw] of stored) {
        const tail = key.substring(base.length);
        if (tail.startsWith(KEY_PAGE_INFIX)) {
            const inner = tail.substring(KEY_PAGE_INFIX.length);
            const splitAt = inner.indexOf(KEY_LOCALE_INFIX);
            if (splitAt < 0) continue;
            const pageId = inner.substring(0, splitAt);
            const locale = inner.substring(splitAt + KEY_LOCALE_INFIX.length);
            pageLocaleOverrides[pageId] = pageLocaleOverrides[pageId] || {};
            pageLocaleOverrides[pageId][locale] = parseStored(raw);
        } else if (tail.startsWith(KEY_LOCALE_INFIX)) {
            const locale = tail.substring(KEY_LOCALE_INFIX.length);
            siteLocaleOverrides[locale] = parseStored(raw);
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

    /* Blog posts. Drafts never enter the snapshot — a draft is private until
       its status says otherwise. Scheduled posts DO enter it, with their date:
       the public readers show a post only once publishedAt has passed
       (posts.isPostVisible), so a scheduled post appears on time without a
       job and without another publish. Additive keys, like pageMeta. */
    const allPosts = await listPosts(siteId, { fresh: true });
    const posts = {};
    for (const post of allPosts) {
        if (post.status === 'published' || post.status === 'scheduled') posts[post.id] = post;
    }
    const allPostOverrides = await collectPostLocaleOverrides(siteId, { fresh: true });
    const postLocaleOverrides = {};
    for (const id of Object.keys(posts)) {
        if (allPostOverrides[id]) postLocaleOverrides[id] = allPostOverrides[id];
    }

    const snapshot = {
        version: PUBLISHED_VERSION,
        publishedAt,
        site,
        pages,
        pageMeta,
        siteLocaleOverrides,
        pageLocaleOverrides,
        posts,
        postLocaleOverrides,
        // Additive: the public renderer answers these before the 404/410 decision.
        redirects: (await getRedirects(siteId, { fresh: true })).redirects,
    };
    await configStore.setConfig(publishedKey(siteId), snapshot);
    return { publishedAt: snapshot.publishedAt };
}

module.exports = { getPublishedSnapshot, publishSite };
