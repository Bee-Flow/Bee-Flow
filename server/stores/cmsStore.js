// @typecheck
/**
 * CMS Store — multi-project website builder.
 *
 * The CMS is a standalone tool inside Bee Flow that lets users build their
 * own websites (a bakery's site, a consultancy's site, a portfolio, etc.) —
 * each one fully independent. There is no single "Bee Flow website" being
 * edited here; every key is scoped to a specific project (`siteId`).
 *
 * Storage keys (all in the `config` table via configStore):
 *   cms_default_locale                                    string   fallback locale (default 'en')
 *   cms_projects_index                                    array    ordered list of {id, name, createdAt, updatedAt}
 *   cms_project_{siteId}                                  SiteDoc  per-site settings + page index
 *   cms_project_{siteId}_locale_{xx}                      site-locale override
 *   cms_project_{siteId}_page_{pageId}                    PageDoc
 *   cms_project_{siteId}_page_{pageId}_locale_{xx}        page-locale override
 *
 * Effective content for a request = SITE_DEFAULTS / BLOCK_DEFAULTS  ←
 *                                   default-locale stored content   ←
 *                                   requested-locale overrides.
 *
 * Locale overrides for blocks are keyed by block ID (not array index) so
 * reordering blocks never breaks translations.
 *
 * Serving model (Option A): preview only inside the admin iframe. There is
 * no public route that serves a project — publishing/domains is a future
 * phase. Callers in the admin panel pass siteId explicitly on every call.
 *
 * Facade: the implementation lives in ./cms/* aggregates behind this stable
 * path — every require('../stores/cmsStore') caller is unchanged. Each
 * aggregate exports its public functions; this file re-exports the same
 * references under the identical surface this file had before the split.
 */

const { BLOCK_TYPE_IDS, RESERVED_SLUGS } = require('../i18n/defaults/cmsDefaults');
const {
    makeBlock, sanitizeBlocks,
    getPage, setPage, deletePage,
} = require('./cms/pages');
const {
    isValidLocale, getDefaultLocale, setDefaultLocale,
    getSiteLocaleOverride, setSiteLocaleOverride, deleteSiteLocaleOverride,
    getPageLocaleOverride, setPageLocaleOverride, deletePageLocaleOverride,
    collectLocaleOverrides, pruneBlockLocaleOverrides,
} = require('./cms/localeOverrides');
const {
    listProjects, createProject, getProject, setProject,
    deleteProject, renameProject, duplicateProject, sanitizePageIndexEntry,
    createPage, removePage, updatePageMeta, setHomepage, reorderPages,
} = require('./cms/projects');
const {
    getTemplates, saveTemplate, deleteTemplate, applyTemplate,
} = require('./cms/templates');
const { publishSite, getPublishedSnapshot } = require('./cms/publishing');
const {
    resolveLink, getEffective, getEffectivePublished,
} = require('./cms/effective');
const { getSiteGraph, getAdminPayload } = require('./cms/adminViews');
const { getBuilderSession, setBuilderSession } = require('./cms/builderSession');
const {
    exportSite, importSite, collectAssetKeys,
    EXPORT_MARKER, EXPORT_VERSION, EXPORT_SUPPORTED_VERSIONS,
} = require('./cms/exportImport');
const { mergeLocaleContent, sanitizeAnalytics } = require('./cms/shared');

module.exports = {
    // locale settings
    getDefaultLocale, setDefaultLocale, isValidLocale,
    // projects
    listProjects, createProject, getProject, setProject, deleteProject, renameProject, duplicateProject,
    // site-locale overrides
    getSiteLocaleOverride, setSiteLocaleOverride, deleteSiteLocaleOverride,
    // pages
    getPage, setPage, deletePage,
    getPageLocaleOverride, setPageLocaleOverride, deletePageLocaleOverride,
    createPage, removePage, updatePageMeta, setHomepage, reorderPages,
    // page templates (global)
    getTemplates, saveTemplate, deleteTemplate, applyTemplate,
    // preview / graph
    getEffective, getEffectivePublished, getSiteGraph,
    // publishing
    publishSite, getPublishedSnapshot,
    // admin
    getAdminPayload,
    // AI builder session + locale-override pruning
    getBuilderSession, setBuilderSession, pruneBlockLocaleOverrides,
    // import / export
    exportSite, importSite, collectAssetKeys, collectLocaleOverrides,
    EXPORT_MARKER, EXPORT_VERSION, EXPORT_SUPPORTED_VERSIONS,
    // helpers / constants for tests
    makeBlock, resolveLink, mergeLocaleContent, sanitizeBlocks,
    sanitizeAnalytics, sanitizePageIndexEntry,
    BLOCK_TYPE_IDS, RESERVED_SLUGS,
};
