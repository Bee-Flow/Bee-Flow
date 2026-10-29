// @typecheck
// The SiteDoc aggregate: the projects index, project CRUD (create, read,
// write, delete, rename, duplicate) and the page-list operations — the page
// index lives inside the SiteDoc, so creating/renaming/reordering/removing a
// page is a SiteDoc mutation and belongs here rather than with the PageDocs.

const configStore = require('../configStore');
const { revOf, assertRevMatches } = require('./revision');
const { getAll } = require('../../db');
const { SITE_DEFAULTS, DESIGN_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');
const {
    KEY_PROJECTS_INDEX, SITE_VERSION, INDEX_VERSION,
    newId, isPlainObject, isRecord, clone, normalizeSlug, isReservedSlug, assertSiteId,
    sanitizeAnalytics, sanitizeBlogSettings,
    projectKey, publishedKey,
} = require('./shared');
const { emptyPage, getPage, setPage, mutatePage } = require('./pages');
const { migrateSite, sanitizeSite, sanitizePageIndexEntry } = require('./siteDoc');
const { applyTemplate } = require('./templates');
const {
    collectLocaleOverrides, setSiteLocaleOverride, setPageLocaleOverride, writeSiteAligned,
} = require('./localeOverrides');
const { withConfigGroup, realignSiteOverrides } = require('./overrideAlign');
const { listPosts, collectPostLocaleOverrides, restorePosts } = require('./posts');
const redirectsStore = require('./redirects');

// ── Projects index ───────────────────────────────────────────────────

function emptyIndex() {
    return { version: INDEX_VERSION, projects: [] };
}

async function getProjectsIndex() {
    const v = await configStore.getConfig(KEY_PROJECTS_INDEX);
    if (!isPlainObject(v) || !Array.isArray(v.projects)) return emptyIndex();
    return v;
}

async function setProjectsIndex(index) {
    await configStore.setConfig(KEY_PROJECTS_INDEX, {
        version: INDEX_VERSION,
        projects: Array.isArray(index.projects) ? index.projects : [],
    });
}

// Atomic add/remove of a project index ENTRY, serialized across replicas so a
// concurrent site create/import/delete on another pod can't drop an entry
// (which would orphan a cms_project_* doc). `mutator(index)` edits the index in
// place. Use this — not getProjectsIndex→mutate→setProjectsIndex — whenever the
// set of projects changes. The name/updatedAt touch after every site write
// (touchProjectsIndexEntry) goes through here too, so it can never restore a
// stale index over a concurrent create.
async function mutateProjectsIndex(mutator) {
    return configStore.mutateConfig(KEY_PROJECTS_INDEX, (cur) => {
        const index = (isPlainObject(cur) && Array.isArray(cur.projects)) ? cur : emptyIndex();
        mutator(index);
        return { version: INDEX_VERSION, projects: Array.isArray(index.projects) ? index.projects : [] };
    });
}

async function listProjects() {
    const index = await getProjectsIndex();
    return index.projects.map(p => ({
        id: p.id,
        name: p.name || 'Untitled site',
        // Versioning fields. Backfilled here for index entries that
        // pre-date versioning: such a site is its own version group
        // (groupId = its id) and is named "v1".
        versionGroupId: p.versionGroupId || p.id,
        versionName: p.versionName || 'v1',
        createdAt: p.createdAt || null,
        updatedAt: p.updatedAt || null,
    }));
}

// ── Project CRUD ─────────────────────────────────────────────────────

function emptySite(siteId, name) {
    return {
        version: SITE_VERSION,
        id: siteId,
        name: name || 'Untitled site',
        // A brand-new site founds its own version group. Duplicates copy
        // this groupId so every version of a site shares one identifier.
        versionGroupId: siteId,
        versionName: 'v1',
        homepageId: null,
        pages: [],
        header: clone(SITE_DEFAULTS.header),
        footer: clone(SITE_DEFAULTS.footer),
        cookieBanner: clone(SITE_DEFAULTS.cookieBanner),
        announcement: clone(SITE_DEFAULTS.announcement),
        analytics: clone(SITE_DEFAULTS.analytics),
        design: clone(DESIGN_DEFAULTS),
    };
}

/**
 * Create a new project. Returns the freshly-registered project entry.
 * The new site is seeded with exactly one empty Home page (zero blocks);
 * the user adds blocks manually via the admin panel.
 * @param {{ name?: string }} [opts]
 */
async function createProject({ name } = {}) {
    const siteId = newId('pj');
    const now = new Date().toISOString();
    const site = emptySite(siteId, name);

    // Write the site doc first; if the index write fails the orphan
    // record is harmless and easy to garbage-collect later.
    await configStore.setConfig(projectKey(siteId), site);

    await mutateProjectsIndex((index) => {
        index.projects.push({
            id: siteId,
            name: site.name,
            versionGroupId: site.versionGroupId,
            versionName: site.versionName,
            createdAt: now,
            updatedAt: now,
        });
    });

    // Seed an empty Home page so a fresh site is immediately editable
    // (with no Bee-Flow-flavored block content). createPage handles the
    // homepage promotion since site.homepageId is currently null.
    await createPage(siteId, { slug: 'home', title: 'Home' });

    return { id: siteId, name: site.name, createdAt: now, updatedAt: now };
}

async function getProject(siteId, { fresh = false } = {}) {
    assertSiteId(siteId);
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const stored = await read(projectKey(siteId));
    if (!isPlainObject(stored)) return null;
    // getConfig hands back the replica's SHARED cached object. Migrate (and let
    // callers edit) a private copy, so neither migrateSite's in-place upgrade
    // nor an edit whose save then fails becomes what this replica serves next.
    return migrateSite(structuredClone(stored));
}

/**
 * Full replace of a SiteDoc, page list included. Only for seeding and tests —
 * a caller that holds a copy older than the stored page list would bring back
 * deleted pages and orphan new ones. Product code edits chrome through
 * updateSiteChrome and the page list through the page-list operations below.
 * @param {string} siteId
 * @param {unknown} site
 * @param {{ localeOverrides?: Record<string, any> }} [report] receives the site translations that were re-aligned
 * @param {{ expectedRev?: number }} [opts]
 */
async function setProject(siteId, site, report, { expectedRev } = {}) {
    assertSiteId(siteId);
    if (!isRecord(site)) throw new Error('Site must be an object');
    const sanitized = sanitizeSite(siteId, site);
    /** @type {{ localeOverrides?: Record<string, any>, rev?: number }} */
    const written = report || {};
    await writeSiteAligned(siteId, sanitized, written, { expectedRev, bumpRev: true });
    await touchProjectsIndexEntry(siteId, sanitized);
    return { ...sanitized, rev: written.rev ?? 0 };
}

/**
 * Atomic read-modify-write of one SiteDoc: `mutator(site)` edits a fresh,
 * migrated copy read under configStore.mutateConfig's cross-replica advisory
 * lock, and the sanitized result is written in the same transaction. Every
 * page-list operation goes through here, so two editors (or one replica with
 * a stale cache) can no longer silently drop each other's page.
 *
 * The mutator must be synchronous and side-effect free (it runs inside the
 * transaction); throwing aborts the write. Returns the saved site and
 * whatever the mutator returned.
 *
 * `rev` is the revision of the site CHROME (name, header, footer, design, ...):
 * `bumpRev` marks a chrome edit and raises it, `expectedRev` refuses the edit
 * with 409 when the chrome was saved elsewhere since the caller read it.
 * Page-list operations leave it alone, so creating a page never makes an open
 * chrome editor stale.
 * @template T
 * @param {string} siteId
 * @param {(site: any) => T} mutator
 * @param {{ expectedRev?: number, bumpRev?: boolean | ((result: T) => boolean) }} [opts]
 *   `bumpRev` may be a function of the mutator's result when only some edits touch chrome
 * @returns {Promise<{ site: any, result: T, localeOverrides: Record<string, any> }>}
 */
async function mutateProject(siteId, mutator, { expectedRev, bumpRev = false } = {}) {
    assertSiteId(siteId);
    /** @type {T} (assigned by the mutator inside the transaction; a failed transaction throws before the return) */
    let result;
    /** @type {Record<string, any>} */
    let moved = {};
    // Same transaction as the re-alignment of the site translations: a mutator
    // that removes or reorders header/footer items must not shift them.
    const saved = await withConfigGroup(projectKey(siteId), async (io) => {
        const cur = await io.get(projectKey(siteId));
        if (!isPlainObject(cur)) throw new Error('Project not found');
        const curRev = revOf(cur);
        assertRevMatches(cur, expectedRev, 'site');
        const site = migrateSite(structuredClone(cur));
        if (!Array.isArray(site.pages)) site.pages = [];
        result = mutator(site);
        const sanitized = sanitizeSite(siteId, site);
        const nextRev = (typeof bumpRev === 'function' ? bumpRev(result) : bumpRev) ? curRev + 1 : curRev;
        const stored = { ...sanitized, rev: nextRev };
        await io.set(projectKey(siteId), stored);
        moved = await realignSiteOverrides(io, siteId, cur, sanitized);
        return stored;
    });
    await touchProjectsIndexEntry(siteId, saved);
    return { site: saved, result, localeOverrides: moved };
}

/** The SiteDoc fields an editor may write: chrome, never the page list. */
const SITE_CHROME_FIELDS = ['name', 'header', 'footer', 'cookieBanner', 'announcement', 'analytics', 'design', 'blog'];

/**
 * Save the chrome fields of `patch` onto the CURRENT SiteDoc (read under the
 * lock). `pages` and `homepageId` in `patch` are ignored on purpose: the page
 * list belongs to the page-list operations.
 * @param {string} siteId
 * @param {Record<string, any>} patch
 * @param {{ expectedRev?: number, report?: { localeOverrides?: Record<string, any> } }} [opts]
 *   `report` receives the site translations that were re-aligned
 */
async function updateSiteChrome(siteId, patch, { expectedRev, report } = {}) {
    if (!isPlainObject(patch)) throw new Error('Site must be an object');
    const { site, localeOverrides } = await mutateProject(siteId, (s) => {
        for (const field of SITE_CHROME_FIELDS) {
            if (patch[field] !== undefined) s[field] = patch[field];
        }
    }, { expectedRev, bumpRev: true });
    if (report) report.localeOverrides = localeOverrides;
    return site;
}

// Touch the index so listProjects() reflects the new name + updatedAt. Under
// the index lock: a plain read-modify-write here would restore a stale index
// and drop a site created or imported at the same moment.
async function touchProjectsIndexEntry(siteId, sanitized) {
    await mutateProjectsIndex((index) => {
        const entry = index.projects.find(p => p.id === siteId);
        if (!entry) return;
        entry.name = sanitized.name;
        // Mirror versioning fields onto the index entry so listProjects()
        // can build the version switcher without reading every SiteDoc.
        entry.versionGroupId = sanitized.versionGroupId;
        entry.versionName = sanitized.versionName;
        entry.updatedAt = new Date().toISOString();
    });
}

/**
 * Delete a project and every key associated with it. Idempotent: returns
 * silently if the site doesn't exist.
 */
async function deleteProject(siteId) {
    assertSiteId(siteId);
    const rows = await getAll(
        `SELECT key FROM config WHERE key = $1 OR key LIKE $2`,
        [projectKey(siteId), `${projectKey(siteId)}_%`]
    );
    for (const r of rows) await configStore.deleteConfig(r.key);
    // Published snapshot uses a separate prefix — clean it up explicitly.
    await configStore.deleteConfig(publishedKey(siteId));

    await mutateProjectsIndex((index) => {
        index.projects = index.projects.filter(p => p.id !== siteId);
    });
}

async function renameProject(siteId, name) {
    const { site } = await mutateProject(siteId, (s) => { s.name = name; }, { bumpRev: true });
    return site;
}

/**
 * Duplicate a project into a new version of the same version group.
 *
 * Deep-copies the SiteDoc, every PageDoc, and every block — all with
 * fresh ids — and rewrites internal `{kind:'page', pageId}` link
 * references (header / footer chrome + block content) to the cloned
 * page ids so the copy's links stay self-contained.
 *
 * The new site shares the source's `versionGroupId`, is named the next
 * free "v{n}" within that group, and is NOT made live (live is the
 * single global cms_live_site_id, untouched here).
 */
async function duplicateProject(sourceSiteId) {
    const source = await getProject(sourceSiteId);
    if (!source) throw new Error('Project not found');

    const newSiteId = newId('pj');
    const now = new Date().toISOString();
    const versionGroupId = source.versionGroupId || sourceSiteId;

    // Pre-allocate the old→new page id mapping so links can be rewritten
    // before any PageDoc is written.
    const pageIdMap = new Map();
    for (const entry of source.pages || []) {
        if (entry && entry.id) pageIdMap.set(entry.id, newId('pg'));
    }

    // Rewrite {kind:'page', pageId} references onto the cloned page ids.
    // Non-page links and primitives pass through untouched.
    const remap = (node) => {
        if (Array.isArray(node)) return node.map(remap);
        if (!isPlainObject(node)) return node;
        if (node.kind === 'page' && node.pageId && pageIdMap.has(node.pageId)) {
            return { ...node, pageId: pageIdMap.get(node.pageId) };
        }
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = remap(v);
        return out;
    };

    // Next free "v{n}" label within the group — max existing suffix + 1.
    const index = await getProjectsIndex();
    let maxN = 0;
    for (const p of index.projects) {
        if ((p.versionGroupId || p.id) !== versionGroupId) continue;
        const m = /^v(\d+)$/.exec(p.versionName || 'v1');
        maxN = Math.max(maxN, m ? parseInt(m[1], 10) : 1);
    }
    const versionName = `v${maxN + 1}`;

    const newSite = {
        version: SITE_VERSION,
        id: newSiteId,
        name: source.name,
        versionGroupId,
        versionName,
        homepageId: source.homepageId ? (pageIdMap.get(source.homepageId) || null) : null,
        pages: (source.pages || [])
            .filter(e => e && pageIdMap.has(e.id))
            .map(e => ({ ...clone(e), id: pageIdMap.get(e.id) })),
        header: remap(clone(source.header || {})),
        footer: remap(clone(source.footer || {})),
        // No internal page-links inside the banner (privacyUrl is a plain
        // URL string), so a straight clone is enough — no remap needed.
        cookieBanner: clone(source.cookieBanner || {}),
        announcement: clone(source.announcement || {}),
        // Analytics has no page links either; sanitizeAnalytics both copies
        // and guarantees the complete shape for sources that pre-date it.
        analytics: sanitizeAnalytics(source.analytics),
        design: clone(source.design || {}),
        blog: sanitizeBlogSettings(source.blog),
    };
    await configStore.setConfig(projectKey(newSiteId), newSite);
    await redirectsStore.restoreRedirects(newSiteId, await redirectsStore.getRedirects(sourceSiteId, { fresh: true }));

    // Deep-copy each PageDoc with a fresh page id + fresh block ids,
    // remapping any internal page links inside block content too. Block ids
    // are tracked because the locale overrides copied below are keyed by them.
    const blockIdMapByPage = new Map();   // oldPageId → Map(oldBlockId → newBlockId)
    for (const entry of source.pages || []) {
        const doc = await getPage(sourceSiteId, entry.id);
        if (!doc) continue;
        const newPageId = pageIdMap.get(entry.id);
        const blockIdMap = new Map();
        blockIdMapByPage.set(entry.id, blockIdMap);
        await setPage(newSiteId, {
            ...clone(doc),
            id: newPageId,
            blocks: (doc.blocks || []).map(b => {
                const freshId = newId('blk');
                if (b && typeof b.id === 'string' && b.id) blockIdMap.set(b.id, freshId);
                return {
                    ...clone(b),
                    id: freshId,
                    content: isPlainObject(b.content) ? remap(b.content) : (b.content || {}),
                };
            }),
        });
    }

    // Copy every translation across, remapped onto the clone's ids. Without
    // this a "duplicate" produced an English-only copy — the same silent gap
    // export v1 had, and just as invisible until someone opened the locale.
    const { siteByLocale, pagesByLocale } = await collectLocaleOverrides(sourceSiteId);
    for (const [locale, override] of Object.entries(siteByLocale)) {
        if (!isPlainObject(override)) continue;
        const out = {};
        if (isPlainObject(override.header)) out.header = clone(override.header);
        if (isPlainObject(override.footer)) out.footer = clone(override.footer);
        if (isPlainObject(override.pageTitles)) {
            const byId = {};
            for (const [oldPageId, title] of Object.entries(override.pageTitles)) {
                const newPageId = pageIdMap.get(oldPageId);
                if (newPageId) byId[newPageId] = title;
            }
            if (Object.keys(byId).length) out.pageTitles = byId;
        }
        if (Object.keys(out).length) await setSiteLocaleOverride(newSiteId, locale, out);
    }
    for (const [oldPageId, byLocale] of Object.entries(pagesByLocale)) {
        const newPageId = pageIdMap.get(oldPageId);
        const blockIdMap = blockIdMapByPage.get(oldPageId);
        if (!newPageId || !blockIdMap) continue;
        for (const [locale, override] of Object.entries(byLocale)) {
            if (!isPlainObject(override)) continue;
            const out = {};
            if (isPlainObject(override.blocks)) {
                const blocks = {};
                for (const [oldBlockId, entry] of Object.entries(override.blocks)) {
                    const newBlockId = blockIdMap.get(oldBlockId);
                    if (newBlockId) blocks[newBlockId] = clone(entry);
                }
                if (Object.keys(blocks).length) out.blocks = blocks;
            }
            if (isPlainObject(override.seo)) out.seo = clone(override.seo);
            if (Object.keys(out).length) await setPageLocaleOverride(newSiteId, newPageId, locale, out);
        }
    }

    // Blog posts and their translations, with fresh post ids. Status and dates
    // carry over; the copy is a draft site, so nothing is visible until it is
    // published (and made live) itself.
    const sourcePosts = await listPosts(sourceSiteId, { fresh: true });
    if (sourcePosts.length) {
        await restorePosts(newSiteId, sourcePosts, await collectPostLocaleOverrides(sourceSiteId, { fresh: true }));
    }

    await mutateProjectsIndex((idx) => {
        idx.projects.push({
            id: newSiteId,
            name: newSite.name,
            versionGroupId,
            versionName,
            createdAt: now,
            updatedAt: now,
        });
    });

    return { id: newSiteId, name: newSite.name, versionGroupId, versionName, createdAt: now, updatedAt: now };
}

// ── Page-list operations (mutate site doc atomically) ────────────────

/**
 * @param siteId
 * @param {{ slug?: string, title?: string, copyFromId?: string, templateId?: string }} [opts]
 */
async function createPage(siteId, { slug, title, copyFromId, templateId } = {}) {
    // A fresh read to validate and plan the slug before the PageDoc is written;
    // the authoritative slug is picked again under the lock below.
    const site = await getProject(siteId, { fresh: true });
    if (!site) throw new Error('Project not found');

    const id = newId('pg');
    const baseSlug = normalizeSlug(slug || title || 'untitled') || 'untitled';
    const plannedSlug = ensureUniqueSlug(baseSlug, Array.isArray(site.pages) ? site.pages : [], null);
    if (isReservedSlug(plannedSlug)) throw new Error(`Slug "${plannedSlug}" is reserved`);

    let page;
    if (copyFromId) {
        const source = await getPage(siteId, copyFromId);
        if (!source) throw new Error('Source page not found');
        page = {
            ...clone(source),
            id,
            slug: plannedSlug,
            title: title || `${source.title} (copy)`,
            blocks: source.blocks.map(b => ({ ...clone(b), id: newId('blk') })),
        };
    } else if (templateId) {
        // Apply a saved template — blocks come back already deep-cloned
        // with fresh ids, so we can drop them straight onto an empty page.
        const blocks = await applyTemplate(templateId);
        page = {
            ...emptyPage({ id, slug: plannedSlug, title: title || plannedSlug }),
            blocks,
        };
    } else {
        page = emptyPage({ id, slug: plannedSlug, title: title || plannedSlug });
    }
    await setPage(siteId, page);

    // New pages are NOT auto-added to the header nav. The user adds nav
    // items explicitly via Site chrome → Nav links and picks "Internal
    // page" if they want this page to appear there.
    const { result: savedSlug } = await mutateProject(siteId, (s) => {
        // Another editor may have taken the planned slug in the meantime.
        const lockedSlug = ensureUniqueSlug(baseSlug, s.pages, null);
        if (isReservedSlug(lockedSlug)) throw new Error(`Slug "${lockedSlug}" is reserved`);
        s.pages.push({
            id, slug: lockedSlug, title: page.title,
            isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false,
        });
        if (!s.homepageId) s.homepageId = id;
        return lockedSlug;
    });
    if (savedSlug !== page.slug) {
        page.slug = savedSlug;
        await setPage(siteId, page);
    }
    // The page owns this address now: a redirect from it would shadow the page.
    await redirectsStore.releaseSlug(siteId, savedSlug);
    return { id, slug: savedSlug };
}

function ensureUniqueSlug(slug, pages, ignoreId) {
    let candidate = slug;
    let i = 2;
    while (pages.some(p => p.id !== ignoreId && p.slug === candidate)) {
        candidate = `${slug}-${i++}`;
    }
    return candidate;
}

async function updatePageMeta(siteId, pageId, patch = {}) {
    let previousSlug = '';
    let wasHomepage = false;
    const { result: current } = await mutateProject(siteId, (site) => {
        const idx = site.pages.findIndex(p => p.id === pageId);
        if (idx < 0) throw new Error('Page not found');
        const entry = site.pages[idx];
        previousSlug = entry.slug;
        wasHomepage = site.homepageId === pageId;

        if (patch.slug !== undefined) {
            const next = normalizeSlug(patch.slug) || entry.slug;
            if (isReservedSlug(next)) throw new Error(`Slug "${next}" is reserved`);
            entry.slug = ensureUniqueSlug(next, site.pages, pageId);
        }
        if (typeof patch.title === 'string') entry.title = patch.title;
        if (typeof patch.hideHeader === 'boolean') entry.hideHeader = patch.hideHeader;
        if (typeof patch.hideFooter === 'boolean') entry.hideFooter = patch.hideFooter;
        if (typeof patch.noAnalytics === 'boolean') entry.noAnalytics = patch.noAnalytics;
        if (typeof patch.isNotFound === 'boolean') entry.isNotFound = patch.isNotFound;
        // showInNav / navOrder removed — pages don't drive the nav anymore.

        site.pages[idx] = entry;
        return entry;
    });

    // The old address keeps working: a 301 to the new one (not for the homepage,
    // whose URL is "/" whatever its slug).
    if (patch.slug !== undefined && !wasHomepage && previousSlug !== current.slug) {
        await redirectsStore.recordRename(siteId, previousSlug, current.slug);
    }

    // The PageDoc mirrors the slug/title the locked write settled on.
    // Under the page's revision check, so a block edit saved meanwhile survives.
    const mirrorsIndex = patch.slug !== undefined || patch.title !== undefined;
    if (mirrorsIndex && await getPage(siteId, pageId, { fresh: true })) {
        await mutatePage(siteId, pageId, (page) => {
            if (patch.slug  !== undefined) page.slug  = current.slug;
            if (patch.title !== undefined) page.title = current.title;
            return page;
        });
    }
    return current;
}

async function setHomepage(siteId, pageId) {
    await mutateProject(siteId, (site) => {
        if (!site.pages.find(p => p.id === pageId)) throw new Error('Page not found');
        site.homepageId = pageId;
    });
}

async function reorderPages(siteId, orderedIds) {
    await mutateProject(siteId, (site) => {
        const byId = new Map(site.pages.map(p => [p.id, p]));
        const next = [];
        for (const id of orderedIds) {
            if (byId.has(id)) {
                next.push(byId.get(id));
                byId.delete(id);
            }
        }
        for (const p of site.pages) if (byId.has(p.id)) next.push(p);
        site.pages = next;
    });
}

module.exports = {
    // projects index
    getProjectsIndex, setProjectsIndex, mutateProjectsIndex, listProjects,
    // project CRUD
    emptySite, createProject, getProject, setProject, mutateProject, updateSiteChrome,
    deleteProject, renameProject, duplicateProject, sanitizePageIndexEntry,
    // page-list operations
    createPage, ensureUniqueSlug, updatePageMeta, setHomepage, reorderPages,
};
