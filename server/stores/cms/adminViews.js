// @typecheck
// Composite read views for the admin panel: the page graph behind the sitemap
// diagram, and the full editor payload for one project.

const { isPlainObject, sanitizeDesign } = require('./shared');
const { getProject } = require('./projects');
const { getPage } = require('./pages');
const { getDefaultLocale, collectLocaleOverrides } = require('./localeOverrides');
const { getPublishedSnapshot } = require('./publishing');

/**
 * Compute the page graph for the sitemap diagram.
 * Edges are deduped per (source, target).
 */
async function getSiteGraph(siteId) {
    const site = await getProject(siteId);
    if (!site) return { nodes: [], edges: [] };

    const nodes = site.pages.map(p => ({
        id: p.id, slug: p.slug, title: p.title, isHomepage: !!p.isHomepage,
    }));

    const seen = new Set();
    const edges = [];
    const addEdge = (source, target) => {
        if (!source || !target || source === target) return;
        const k = `${source}->${target}`;
        if (seen.has(k)) return;
        seen.add(k);
        edges.push({ source, target });
    };

    const collectPageLinks = (sourceId, node) => {
        if (Array.isArray(node)) { node.forEach(n => collectPageLinks(sourceId, n)); return; }
        if (!isPlainObject(node)) return;
        if (node.kind === 'page' && node.pageId) addEdge(sourceId, node.pageId);
        for (const v of Object.values(node)) collectPageLinks(sourceId, v);
    };

    const chromeTargets = new Set();
    const collectChrome = (node) => {
        if (Array.isArray(node)) { node.forEach(collectChrome); return; }
        if (!isPlainObject(node)) return;
        if (node.kind === 'page' && node.pageId) chromeTargets.add(node.pageId);
        for (const v of Object.values(node)) collectChrome(v);
    };
    collectChrome(site.header);
    collectChrome(site.footer);

    for (const entry of site.pages) {
        const page = await getPage(siteId, entry.id);
        if (page) collectPageLinks(entry.id, page.blocks);
        for (const target of chromeTargets) addEdge(entry.id, target);
    }

    return { nodes, edges };
}

// ── Admin payload (full editor state for one project) ────────────────

async function getAdminPayload(siteId) {
    // The editor requires strict read-your-writes: after a debounced PUT the
    // panel re-fetches this payload (on tab focus, after page CRUD, or a
    // refresh), and a cache-served stale read on another replica is exactly
    // what makes edits appear to "revert". So every read here bypasses the
    // per-replica config cache. Public/preview reads (getEffective, /site)
    // stay cached — cross-replica invalidation (LISTEN/NOTIFY) bounds their
    // staleness separately.
    const site = await getProject(siteId, { fresh: true });
    if (!site) throw new Error('Project not found');

    // Lazily fill design defaults on read so panel doesn't have to special-case
    // sites stored before the design system existed. The next save persists it
    // through setProject's sanitizer (no extra write here).
    site.design = sanitizeDesign(site.design);

    const defaultLocale = await getDefaultLocale({ fresh: true });

    const pages = [];
    for (const entry of site.pages) {
        const page = await getPage(siteId, entry.id, { fresh: true });
        if (page) pages.push(page);
    }

    // Every locale override for this project (see collectLocaleOverrides —
    // shared with exportSite and duplicateProject). Fresh reads, same
    // read-your-writes reason as above.
    const { siteByLocale, pagesByLocale } = await collectLocaleOverrides(siteId, { fresh: true });

    const snap = await getPublishedSnapshot(siteId, { fresh: true });

    return {
        defaultLocale,
        site,
        pages,
        localeOverrides: { siteByLocale, pagesByLocale },
        publishedAt: snap?.publishedAt || null,
    };
}

module.exports = { getSiteGraph, getAdminPayload };
