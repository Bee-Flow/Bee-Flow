// @typecheck
// The shape of a stored SiteDoc: the lazy upgrades of older documents
// (migrateSite) and the whitelist rebuild every write goes through
// (sanitizeSite, sanitizePageIndexEntry). Pure functions, no storage access.

const { SITE_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');
const {
    SITE_VERSION, newId, isPlainObject, clone, normalizeStoredSlug,
    sanitizeDesign, sanitizeAnalytics, sanitizeBlogSettings,
} = require('./shared');
const { revOf } = require('./revision');

/**
 * The lazy, in-place upgrades of a stored SiteDoc to the current shape. Sync
 * and side-effect free on anything but `v`, so it also runs inside
 * mutateProject's locked read-modify-write.
 * @param {any} v a private copy of the stored SiteDoc
 */
function migrateSite(v) {
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
    // Revision of the site chrome (see ./revision.js); 0 for sites saved before it existed.
    v.rev = revOf(v);

    return v;
}

/**
 * @param {string} siteId
 */
function sanitizeSite(siteId, site) {
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
        blog: sanitizeBlogSettings(site.blog),
    };

    if (sanitized.homepageId && !sanitized.pages.find(p => p.id === sanitized.homepageId)) {
        sanitized.homepageId = sanitized.pages[0]?.id || null;
    }
    sanitized.pages = sanitized.pages.map(p => ({
        ...p,
        isHomepage: p.id === sanitized.homepageId,
    }));
    return sanitized;
}

function sanitizePageIndexEntry(entry) {
    if (!isPlainObject(entry) || !entry.id) return null;
    // showInNav / navOrder were used by the old auto-merge of pages into
    // the header nav. Pages no longer drive the nav, so those fields are
    // intentionally omitted here — old persisted values are dropped on
    // the next save (lazy cleanup, no migration script needed).
    return {
        id: String(entry.id),
        slug: normalizeStoredSlug(entry.slug || ''),
        title: typeof entry.title === 'string' ? entry.title : '',
        isHomepage: !!entry.isHomepage,
        hideHeader: !!entry.hideHeader,
        hideFooter: !!entry.hideFooter,
        noAnalytics: !!entry.noAnalytics,
        isNotFound: !!entry.isNotFound,
    };
}

module.exports = { migrateSite, sanitizeSite, sanitizePageIndexEntry };
