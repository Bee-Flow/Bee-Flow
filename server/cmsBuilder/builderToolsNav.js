// @typecheck
const cmsStore = require('../stores/cmsStore');
const { sanitizeNavIcon } = require('./navIcon');
const { LINK_HINT } = require('./schemas');
const { isPlainObject, clone, newId, pageIdsHint, findIndexEntry, refreshSite } = require('./builderToolsShared');

// Header-nav caps (cms_update_header_nav). The tool owns ALL nav validation:
// cmsStore.setProject stores header.nav verbatim with zero checks.
const NAV_LIMITS = { topLevel: 20, children: 10, columns: 4, columnItems: 10 };

const NAV_LINK_KINDS = ['page', 'external', 'anchor', 'app'];

/**
 * Validate one nav link against the link union; page links must reference
 * an existing page. Returns { link } (cloned) or { error, _fixHint }.
 */
function sanitizeNavLink(draftWrap, link, path) {
    if (!isPlainObject(link)) {
        return { error: `${path}.link must be a link object.`, _fixHint: LINK_HINT };
    }
    if (!NAV_LINK_KINDS.includes(link.kind)) {
        return {
            error: `${path}.link.kind ${JSON.stringify(link.kind ?? null)} is invalid.`,
            _fixHint: `Valid kinds: ${NAV_LINK_KINDS.join(', ')}. ${LINK_HINT}`,
        };
    }
    if (link.kind === 'page' && !findIndexEntry(draftWrap, link.pageId)) {
        return {
            error: `${path}.link points at unknown pageId ${JSON.stringify(link.pageId ?? null)}.`,
            _fixHint: pageIdsHint(draftWrap),
        };
    }
    return { link: clone(link) };
}

/**
 * Validate + whitelist one nav entry (top-level item, child, or mega item —
 * `withExtras` adds the mega-item-only keys). Existing non-empty ids are
 * preserved (locale overrides / stable references survive); missing ids are
 * minted with the nav_ prefix. Unknown keys are dropped by construction.
 * Returns { item } or { error, _fixHint }.
 */
function sanitizeNavEntry(draftWrap, raw, path, { withExtras = false } = {}) {
    if (!isPlainObject(raw)) {
        return { error: `${path} must be an object with { label, link }.`, _fixHint: LINK_HINT };
    }
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label) {
        return { error: `${path}.label must be a non-empty string.`, _fixHint: 'Every menu item needs a visible label.' };
    }
    const linked = sanitizeNavLink(draftWrap, raw.link, path);
    if (linked.error) return linked;
    const item = {
        id: (typeof raw.id === 'string' && raw.id.trim()) ? raw.id.trim() : newId('nav'),
        label,
        link: linked.link,
    };
    if (withExtras) {
        if (typeof raw.description === 'string' && raw.description) item.description = raw.description;
        if (typeof raw.icon === 'string' && raw.icon) {
            const icon = sanitizeNavIcon(raw.icon, path);
            if ('error' in icon) return { error: icon.error, _fixHint: icon._fixHint };
            item.icon = icon.icon;
        }
        if (typeof raw.openInNewTab === 'boolean') item.openInNewTab = raw.openInNewTab;
    }
    return { item };
}

/** Validate + whitelist a mega-menu blob. Returns { dropdown } or { error }. */
function sanitizeNavDropdown(draftWrap, raw, path) {
    if (!isPlainObject(raw)) {
        return { error: `${path} must be an object { layout, columns }.` };
    }
    if (!Array.isArray(raw.columns)) {
        return { error: `${path}.columns must be an array of { heading, items } columns.` };
    }
    if (raw.columns.length > NAV_LIMITS.columns) {
        return { error: `${path}.columns: max ${NAV_LIMITS.columns} columns (got ${raw.columns.length}).` };
    }
    const columns = [];
    for (let i = 0; i < raw.columns.length; i++) {
        const colRaw = raw.columns[i];
        const colPath = `${path}.columns[${i}]`;
        if (!isPlainObject(colRaw)) return { error: `${colPath} must be an object { heading, items }.` };
        if (!Array.isArray(colRaw.items)) return { error: `${colPath}.items must be an array of menu items.` };
        if (colRaw.items.length > NAV_LIMITS.columnItems) {
            return { error: `${colPath}.items: max ${NAV_LIMITS.columnItems} items per column (got ${colRaw.items.length}).` };
        }
        const items = [];
        for (let j = 0; j < colRaw.items.length; j++) {
            const mi = sanitizeNavEntry(draftWrap, colRaw.items[j], `${colPath}.items[${j}]`, { withExtras: true });
            if (mi.error) return mi;
            items.push(mi.item);
        }
        columns.push({
            id: (typeof colRaw.id === 'string' && colRaw.id.trim()) ? colRaw.id.trim() : newId('nav'),
            heading: typeof colRaw.heading === 'string' ? colRaw.heading : '',
            items,
        });
    }
    // ALWAYS 'columns'. Every consumer (Header.jsx readDropdown, the public
    // synthesizeLegacyContent map and the admin preview) renders `columns`
    // only when layout === 'columns'; persisting 'list' here would store the
    // data and then silently render nothing. A flat dropdown is expressed
    // with `children`, not with list-layout columns.
    return { dropdown: { layout: 'columns', columns } };
}

/** Validate the whole replacement nav. Returns { nav } or { error, _fixHint }. */
function sanitizeHeaderNav(draftWrap, rawNav) {
    if (!Array.isArray(rawNav)) {
        return {
            error: 'nav must be an array of menu items — it REPLACES the whole header menu, so send every item you want to keep.',
            _fixHint: LINK_HINT,
        };
    }
    if (rawNav.length > NAV_LIMITS.topLevel) {
        return { error: `nav: max ${NAV_LIMITS.topLevel} top-level items (got ${rawNav.length}).` };
    }
    const nav = [];
    for (let i = 0; i < rawNav.length; i++) {
        const raw = rawNav[i];
        const path = `nav[${i}]`;
        const base = sanitizeNavEntry(draftWrap, raw, path);
        if (base.error) return base;
        const item = base.item;
        if (raw.children !== undefined) {
            if (!Array.isArray(raw.children)) {
                return { error: `${path}.children must be an array of { label, link } sub-items.` };
            }
            if (raw.children.length > NAV_LIMITS.children) {
                return { error: `${path}.children: max ${NAV_LIMITS.children} sub-items (got ${raw.children.length}).` };
            }
            const children = [];
            for (let j = 0; j < raw.children.length; j++) {
                const child = sanitizeNavEntry(draftWrap, raw.children[j], `${path}.children[${j}]`);
                if (child.error) return child;
                children.push(child.item);
            }
            item.children = children;
        }
        if (raw.dropdown !== undefined) {
            const dd = sanitizeNavDropdown(draftWrap, raw.dropdown, `${path}.dropdown`);
            if (dd.error) return dd;
            item.dropdown = dd.dropdown;
        }
        nav.push(item);
    }
    return { nav };
}

async function applyUpdateHeaderNav(draftWrap, args) {
    const sanitized = sanitizeHeaderNav(draftWrap, args?.nav);
    if (sanitized.error) return sanitized;
    // The edit is applied to the SiteDoc as stored NOW, under the store's lock
    // (draftWrap.site can be minutes stale, and sessions are shared between
    // admins): only header.nav changes, so a page another admin created
    // meanwhile, or any other chrome they saved, stays.
    try {
        await cmsStore.mutateProject(draftWrap.siteId, (site) => {
            site.header = { ...(isPlainObject(site.header) ? site.header : {}), nav: sanitized.nav };
        }, { bumpRev: true });
    } catch (e) {
        return { error: e.message };
    }
    await refreshSite(draftWrap);
    const nav = Array.isArray(draftWrap.site?.header?.nav) ? draftWrap.site.header.nav : sanitized.nav;
    return { navCount: nav.length, labels: nav.map((i) => i.label) };
}

module.exports = { NAV_LIMITS, sanitizeHeaderNav, applyUpdateHeaderNav };
