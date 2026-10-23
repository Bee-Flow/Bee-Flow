import type { SiteContent, AnalyticsConfig } from './marketing/ProductWebsite.types';

/** The CMS payload RootPathGate renders; `fromServer` marks one the server inlined. */
export interface CmsState {
    content: SiteContent;
    analytics?: AnalyticsConfig | null;
    fromServer?: boolean;
}

/** The parts of GET /api/cms/site that RootPathGate reads. */
export interface CmsSiteResponse {
    enabled?: boolean;
    appOnly?: boolean;
    found?: boolean;
    canonicalSlug?: string;
    content?: SiteContent;
    analytics?: AnalyticsConfig | null;
}
