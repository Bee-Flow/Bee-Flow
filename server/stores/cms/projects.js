// @typecheck
// The SiteDoc aggregate: the projects index, project CRUD (create, read,
// write, delete, rename, duplicate) and the page-list operations — the page
// index lives inside the SiteDoc, so creating/renaming/reordering/removing a
// page is a SiteDoc mutation and belongs here rather than with the PageDocs.

const configStore = require('../configStore');
const { getAll } = require('../../db');
const { SITE_DEFAULTS, DESIGN_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');
const {
    KEY_PROJECTS_INDEX, SITE_VERSION, INDEX_VERSION,
    newId, isPlainObject, clone, normalizeSlug, isReservedSlug, assertSiteId,
    sanitizeDesign, sanitizeAnalytics,
    projectKey, publishedKey,
} = require('./shared');
const { emptyPage, getPage, setPage, deletePage } = require('./pages');
const { applyTemplate } = require('./templates');
const {
    collectLocaleOverrides, setSiteLocaleOverride, setPageLocaleOverride,
} = require('./localeOverrides');

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
// set of projects changes. Automation field touches (name/updatedAt via
// setProject) stay on the plain path: a lost update there costs only a stale
// timestamp, never membership.
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
    const v = await read(projectKey(siteId));
    if (!isPlainObject(v)) return null;

    // Lazy v1 → v2 migration: pages used to auto-merge into the header
    // nav at render time. That merge was removed; without a one-shot
    // seed, existing live sites would lose their visible nav after the
    // deploy. Seed header.nav from the current page list — but only when
    // the user hasn't customised nav already (empty array or unset). Once
    // setProject persists the bumped version field this branch is inert
    // for that site, so opting back into "no nav at all" by clearing the
    // list later is preserved.
    const storedVersion = typeof v.version === 'number' ? v.version : 1;
    if (storedVersion < SITE_VERSION) {
        const header = isPlainObject(v.header) ? v.header : clone(SITE_DEFAULTS.header);
        const navEmpty = !Array.isArray(header.nav) || header.nav.length === 0;
        const pages = Array.isArray(v.pages) ? v.pages : [];
        if (navEmpty && pages.length > 0) {
            header.nav = pages
                .filter(p => isPlainObject(p) && !p.isHomepage)
                // Preserve the old auto-nav filtering so users who'd
                // already toggled "Show in nav" off don't suddenly see
                // those pages re-appear post-migration.
                .filter(p => p.showInNav !== false)
                .slice()
                .sort((a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0))
                .map(p => ({
                    id: newId('nav'),
                    label: p.title || p.slug,
                    link: { kind: 'page', pageId: p.id },
                }));
            v.header = header;
        }

        // v2 → v3: header now supports a `ctas` array. Seed it from the
        // legacy single-CTA fields once so existing sites keep rendering
        // both their Log in + Get started buttons exactly as before.
        // Order: Log in (ghost) first, primary CTA last — matches the old
        // Header.jsx layout. Skipped if the user already has ctas set
        // (idempotent: re-running the migration is a no-op).
        const ctasEmpty = !Array.isArray(header.ctas) || header.ctas.length === 0;
        if (ctasEmpty) {
            header.ctas = [
                // The old Header always rendered a Log in button with a
                // hard-coded `/app` href, falling back to the literal
                // "Log in" when loginLabel was empty. Match that exactly.
                {
                    id: newId('cta'),
                    label: (typeof header.loginLabel === 'string' && header.loginLabel.trim())
                        ? header.loginLabel
                        : 'Log in',
                    link: { kind: 'app', path: '/app' },
                    style: 'ghost',
                },
                // Primary CTA — derived from ctaLabel + ctaLink. Falls
                // back to a sensible default so a site with no legacy
                // CTA at all gets a starter "Get started" button rather
                // than a blank header.
                {
                    id: newId('cta'),
                    label: header.ctaLabel || 'Get started',
                    link: isPlainObject(header.ctaLink)
                        ? header.ctaLink
                        : { kind: 'app', path: '/app' },
                    style: 'primary',
                },
            ];
            v.header = header;
        }
    }

    // Versioning fields — ensured lazily so sites stored before versioning
    // existed still resolve a groupId. Such a site is its own group
    // (groupId = its id), named "v1". Persisted on the next setProject.
    if (typeof v.versionGroupId !== 'string' || !v.versionGroupId) {
        v.versionGroupId = v.id;
    }
    if (typeof v.versionName !== 'string' || !v.versionName) {
        v.versionName = 'v1';
    }

    return v;
}

async function setProject(siteId, site) {
    assertSiteId(siteId);
    if (!isPlainObject(site)) throw new Error('Site must be an object');

    const sanitized = {
        version: SITE_VERSION,
        id: siteId,
        name: typeof site.name === 'string' && site.name ? site.name : 'Untitled site',
        // Versioning: groupId is immutable once set (falls back to this
        // site's own id for sites that pre-date versioning); versionName
        // is a free-form label ("v1", "v2", …) capped to a sane length.
        versionGroupId: (typeof site.versionGroupId === 'string' && /^pj_[a-f0-9]+$/.test(site.versionGroupId))
            ? site.versionGroupId
            : siteId,
        versionName: (typeof site.versionName === 'string' && site.versionName.trim())
            ? site.versionName.trim().slice(0, 40)
            : 'v1',
        homepageId: site.homepageId || null,
        pages: Array.isArray(site.pages) ? site.pages.map(sanitizePageIndexEntry).filter(Boolean) : [],
        header: isPlainObject(site.header) ? site.header : clone(SITE_DEFAULTS.header),
        footer: isPlainObject(site.footer) ? site.footer : clone(SITE_DEFAULTS.footer),
        cookieBanner: isPlainObject(site.cookieBanner) ? site.cookieBanner : clone(SITE_DEFAULTS.cookieBanner),
        announcement: isPlainObject(site.announcement) ? site.announcement : clone(SITE_DEFAULTS.announcement),
        analytics: sanitizeAnalytics(site.analytics),
        design: sanitizeDesign(site.design),
    };

    if (sanitized.homepageId && !sanitized.pages.find(p => p.id === sanitized.homepageId)) {
        sanitized.homepageId = sanitized.pages[0]?.id || null;
    }
    sanitized.pages = sanitized.pages.map(p => ({
        ...p,
        isHomepage: p.id === sanitized.homepageId,
    }));

    await configStore.setConfig(projectKey(siteId), sanitized);

    // Touch the index so listProjects() reflects the new name + updatedAt.
    const index = await getProjectsIndex();
    const entry = index.projects.find(p => p.id === siteId);
    if (entry) {
        entry.name = sanitized.name;
        // Mirror versioning fields onto the index entry so listProjects()
        // can build the version switcher without reading every SiteDoc.
        entry.versionGroupId = sanitized.versionGroupId;
        entry.versionName = sanitized.versionName;
        entry.updatedAt = new Date().toISOString();
        await setProjectsIndex(index);
    }
    return sanitized;
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
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    site.name = name;
    return setProject(siteId, site);
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
    };
    await configStore.setConfig(projectKey(newSiteId), newSite);

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

function sanitizePageIndexEntry(entry) {
    if (!isPlainObject(entry) || !entry.id) return null;
    // showInNav / navOrder were used by the old auto-merge of pages into
    // the header nav. Pages no longer drive the nav, so those fields are
    // intentionally omitted here — old persisted values are dropped on
    // the next save (lazy cleanup, no migration script needed).
    return {
        id: String(entry.id),
        slug: normalizeSlug(entry.slug || ''),
        title: typeof entry.title === 'string' ? entry.title : '',
        isHomepage: !!entry.isHomepage,
        hideHeader: !!entry.hideHeader,
        hideFooter: !!entry.hideFooter,
        noAnalytics: !!entry.noAnalytics,
        isNotFound: !!entry.isNotFound,
    };
}

// ── Page-list operations (mutate site doc atomically) ────────────────

/**
 * @param siteId
 * @param {{ slug?: string, title?: string, copyFromId?: string, templateId?: string }} [opts]
 */
async function createPage(siteId, { slug, title, copyFromId, templateId } = {}) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');

    const id = newId('pg');
    const baseSlug = normalizeSlug(slug || title || 'untitled') || 'untitled';
    const finalSlug = ensureUniqueSlug(baseSlug, site.pages, null);
    if (isReservedSlug(finalSlug)) throw new Error(`Slug "${finalSlug}" is reserved`);

    let page;
    if (copyFromId) {
        const source = await getPage(siteId, copyFromId);
        if (!source) throw new Error('Source page not found');
        page = {
            ...clone(source),
            id,
            slug: finalSlug,
            title: title || `${source.title} (copy)`,
            blocks: source.blocks.map(b => ({ ...clone(b), id: newId('blk') })),
        };
    } else if (templateId) {
        // Apply a saved template — blocks come back already deep-cloned
        // with fresh ids, so we can drop them straight onto an empty page.
        const blocks = await applyTemplate(templateId);
        page = {
            ...emptyPage({ id, slug: finalSlug, title: title || finalSlug }),
            blocks,
        };
    } else {
        page = emptyPage({ id, slug: finalSlug, title: title || finalSlug });
    }
    await setPage(siteId, page);

    // New pages are NOT auto-added to the header nav. The user adds nav
    // items explicitly via Site chrome → Nav links and picks "Internal
    // page" if they want this page to appear there.
    site.pages.push({
        id, slug: finalSlug, title: page.title,
        isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false,
    });
    if (!site.homepageId) site.homepageId = id;
    await setProject(siteId, site);
    return { id, slug: finalSlug };
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
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    const idx = site.pages.findIndex(p => p.id === pageId);
    if (idx < 0) throw new Error('Page not found');
    const current = site.pages[idx];

    if (patch.slug !== undefined) {
        const next = normalizeSlug(patch.slug) || current.slug;
        if (isReservedSlug(next)) throw new Error(`Slug "${next}" is reserved`);
        current.slug = ensureUniqueSlug(next, site.pages, pageId);
    }
    if (typeof patch.title === 'string') current.title = patch.title;
    if (typeof patch.hideHeader === 'boolean') current.hideHeader = patch.hideHeader;
    if (typeof patch.hideFooter === 'boolean') current.hideFooter = patch.hideFooter;
    if (typeof patch.noAnalytics === 'boolean') current.noAnalytics = patch.noAnalytics;
    if (typeof patch.isNotFound === 'boolean') current.isNotFound = patch.isNotFound;
    // showInNav / navOrder removed — pages don't drive the nav anymore.

    site.pages[idx] = current;

    const page = await getPage(siteId, pageId);
    if (page) {
        if (patch.slug  !== undefined) page.slug  = current.slug;
        if (patch.title !== undefined) page.title = current.title;
        await setPage(siteId, page);
    }
    await setProject(siteId, site);
    return current;
}

async function setHomepage(siteId, pageId) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    if (!site.pages.find(p => p.id === pageId)) throw new Error('Page not found');
    site.homepageId = pageId;
    await setProject(siteId, site);
}

async function reorderPages(siteId, orderedIds) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
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
    await setProject(siteId, site);
}

// Recursively walk a site-chrome subtree (header/footer) and strip any
// link references to the given pageId. The renderer's resolveLink already
// degrades broken page links gracefully ({ href: '#', broken: true }), but
// stored references also show up as ghost nav items in the editor, so we
// clean them at delete time.
//
// Two patterns are handled:
//   1. Array items keyed by `link` (nav items, ctas, footer column links):
//      drop the whole item when its link points at the deleted page.
//   2. Direct link objects on a parent property (e.g. logo.link): replace
//      with an inert anchor link so the parent's shape stays valid.
function stripPageRefsToDeleted(node, deletedPageId) {
    if (Array.isArray(node)) {
        return node
            .filter(item => !(isPlainObject(item)
                && isPlainObject(item.link)
                && item.link.kind === 'page'
                && item.link.pageId === deletedPageId))
            .map(item => stripPageRefsToDeleted(item, deletedPageId));
    }
    if (!isPlainObject(node)) return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (isPlainObject(v) && v.kind === 'page' && v.pageId === deletedPageId) {
            out[k] = { kind: 'anchor', anchor: '' };
            continue;
        }
        out[k] = stripPageRefsToDeleted(v, deletedPageId);
    }
    return out;
}

async function removePage(siteId, pageId) {
    const site = await getProject(siteId);
    if (!site) throw new Error('Project not found');
    site.pages = site.pages.filter(p => p.id !== pageId);
    if (site.homepageId === pageId) site.homepageId = site.pages[0]?.id || null;
    if (isPlainObject(site.header)) site.header = stripPageRefsToDeleted(site.header, pageId);
    if (isPlainObject(site.footer)) site.footer = stripPageRefsToDeleted(site.footer, pageId);
    await setProject(siteId, site);
    await deletePage(siteId, pageId);
}

module.exports = {
    // projects index
    getProjectsIndex, setProjectsIndex, mutateProjectsIndex, listProjects,
    // project CRUD
    emptySite, createProject, getProject, setProject,
    deleteProject, renameProject, duplicateProject, sanitizePageIndexEntry,
    // page-list operations
    createPage, ensureUniqueSlug, updatePageMeta, setHomepage, reorderPages, removePage,
};
