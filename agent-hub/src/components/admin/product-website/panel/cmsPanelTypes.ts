import type { CmsSeo } from '../../../../marketing/useCmsHead';

/**
 * The CMS documents as the panel container reads them. Only the fields the
 * container itself touches are named; the editors and the server own the rest.
 */

export interface CmsLocale {
    code: string;
    name?: string;
    isDefault?: boolean;
}

export interface CmsBlock {
    id: string;
    type: string;
    enabled?: boolean;
    content?: Record<string, unknown>;
    style?: Record<string, unknown>;
    [key: string]: unknown;
}

/** The SEO fields a PageDoc carries. */
export type CmsPageSeo = CmsSeo;

/** A PageDoc: one page's blocks and SEO. */
export interface CmsPageDoc {
    id: string;
    slug?: string;
    title?: string;
    blocks?: CmsBlock[];
    seo?: CmsPageSeo;
    [key: string]: unknown;
}

/** One entry of the SiteDoc's page index; the index-only flags live here, not on the PageDoc. */
export interface CmsPageIndexEntry {
    id: string;
    slug?: string;
    title?: string;
    isHomepage?: boolean;
    hideHeader?: boolean;
    hideFooter?: boolean;
    isNotFound?: boolean;
    noAnalytics?: boolean;
    [key: string]: unknown;
}

/** A PageDoc merged with its index flags — what the page inspector edits. */
export interface CmsActivePage extends CmsPageDoc {
    isHomepage?: boolean;
    hideHeader?: boolean;
    hideFooter?: boolean;
    isNotFound?: boolean;
    noAnalytics?: boolean;
}

export interface CmsBlogIndexSettings {
    title?: Record<string, string>;
    description?: Record<string, string>;
    postsPerPage?: number;
}

/** The SiteDoc: chrome, design, the page index and the blog index settings. */
export interface CmsSiteDoc {
    id?: string;
    homepageId?: string | null;
    versionGroupId?: string;
    pages?: CmsPageIndexEntry[];
    design?: Record<string, unknown>;
    blog?: CmsBlogIndexSettings;
    [key: string]: unknown;
}

/** Sparse per-locale text overrides. */
export interface CmsLocaleOverrides {
    siteByLocale?: Record<string, Record<string, unknown> | undefined>;
    pagesByLocale?: Record<string, Record<string, Record<string, unknown> | undefined> | undefined>;
}

/** One site of GET /api/cms/sites. */
export interface CmsSiteListEntry {
    id: string;
    name?: string;
    updatedAt?: string;
    versionGroupId?: string;
    versionName?: string;
    [key: string]: unknown;
}
