/**
 * CMS API URL builder.
 *
 * Per-site routes use /api/cms/sites/:siteId/* and require an activeSiteId
 * from the panel state. Server-wide routes (enabled flag, default locale,
 * file uploads) live at /api/cms/admin/* — they're not site-specific.
 */
import { apiUrl } from '@/api/typedRequest';

// Each builder names the operation it is mostly called for; the URL is the path's, whatever the method.

export const cmsApi = {
    // ── Site management (no siteId required) ──
    listSites:           ()                            => apiUrl('GET /api/cms/sites'),
    createSite:          ()                            => apiUrl('POST /api/cms/sites'),
    // Import a previously-exported site. Accepts either a multipart .zip
    // (field name `file`) or a raw JSON body. Always creates a NEW siteId —
    // never overwrites an existing one.
    importSite:          ()                            => apiUrl('POST /api/cms/sites/import'),
    // /sites/:siteId → also serves as the SiteDoc / admin payload endpoint
    // for that site (replaces /admin/site).
    site:                (siteId: string)                      => apiUrl('GET /api/cms/sites/{siteId}', { params: { siteId } }),
    // Site export (Content-Disposition: attachment). 'zip' is the complete
    // backup — the bundle plus every referenced image/video; 'json' is the
    // bundle alone, which references assets by key and therefore only
    // reconstitutes fully on an install that shares the storage bucket.
    // Both carry every page, every block and every language.
    siteExport:          (siteId: string, format = 'zip')      => apiUrl('GET /api/cms/sites/{siteId}/export', { params: { siteId }, query: { format } }),
    // Duplicate a site into a new version of the same version group
    // (POST, no body). Returns { id, name, versionGroupId, versionName }.
    siteDuplicate:       (siteId: string)                      => apiUrl('POST /api/cms/sites/{siteId}/duplicate', { params: { siteId } }),

    // ── Per-site editor operations ──
    siteLive:            (siteId: string)                      => apiUrl('PUT /api/cms/sites/{siteId}/live', { params: { siteId } }),
    sitePublish:         (siteId: string)                      => apiUrl('POST /api/cms/sites/{siteId}/publish', { params: { siteId } }),
    // Link check of the draft (POST { external?: boolean }): internal links by default.
    siteLinkCheck:       (siteId: string)                      => apiUrl('POST /api/cms/sites/{siteId}/link-check', { params: { siteId } }),
    siteGraph:           (siteId: string)                      => apiUrl('GET /api/cms/sites/{siteId}/graph', { params: { siteId } }),
    siteLocaleOverride:  (siteId: string, locale: string)              => apiUrl('PUT /api/cms/sites/{siteId}/site/locale/{locale}', { params: { siteId, locale } }),
    pages:               (siteId: string)                      => apiUrl('POST /api/cms/sites/{siteId}/pages', { params: { siteId } }),
    pagesOrder:          (siteId: string)                      => apiUrl('PUT /api/cms/sites/{siteId}/pages/order', { params: { siteId } }),
    page:                (siteId: string, pageId: string)              => apiUrl('GET /api/cms/sites/{siteId}/pages/{id}', { params: { siteId, id: pageId } }),
    pageMeta:            (siteId: string, pageId: string)              => apiUrl('PUT /api/cms/sites/{siteId}/pages/{id}/meta', { params: { siteId, id: pageId } }),
    pageHomepage:        (siteId: string, pageId: string)              => apiUrl('PUT /api/cms/sites/{siteId}/pages/{id}/homepage', { params: { siteId, id: pageId } }),
    pageLocaleOverride:  (siteId: string, pageId: string, locale: string)      => apiUrl('PUT /api/cms/sites/{siteId}/pages/{id}/locale/{locale}', { params: { siteId, id: pageId, locale } }),
    // AI auto-translate — pre-fills a locale override from the default-locale text.
    pageAiTranslate:     (siteId: string, pageId: string, locale: string)      => apiUrl('POST /api/cms/sites/{siteId}/pages/{id}/ai-translate/{locale}', { params: { siteId, id: pageId, locale } }),
    siteAiTranslate:     (siteId: string, locale: string)              => apiUrl('POST /api/cms/sites/{siteId}/site/ai-translate/{locale}', { params: { siteId, locale } }),

    // ── Server-wide (independent of activeSiteId) ──
    enabled:             ()                            => apiUrl('PUT /api/cms/admin/enabled'),
    defaultLocale:       ()                            => apiUrl('PUT /api/cms/admin/default-locale'),
    upload:              ()                            => apiUrl('POST /api/cms/admin/upload'),
    // Page templates — global, shared across all sites. List/save/delete
    // only; "apply" happens by passing `templateId` to POST pages.
    templates:           ()                            => apiUrl('GET /api/cms/admin/templates'),
    template:            (templateId: string)                  => apiUrl('DELETE /api/cms/admin/templates/{id}', { params: { id: templateId } }),
};
