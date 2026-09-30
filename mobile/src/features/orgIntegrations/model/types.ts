/**
 * The organisation's integration settings, as the server serialises them:
 * the Nextcloud tool switches (org-wide and per group) and the org-wide beta
 * switches behind the system knowledge bases. Each names its route.
 */

/** One Nextcloud tool (utils/ncIntegrationCatalog.js NC_INTEGRATIONS). */
export interface NcCatalogItem {
    id: string;
    name: string;
    description: string;
}

/** `GET /auth/admin/:orgId/nc-integrations` (routes/admin/ncIntegrations.js). */
export interface NcIntegrations {
    catalog: NcCatalogItem[];
    /** The tools on for the whole organisation. */
    enabled: string[];
    /** Nothing was ever chosen: every tool is on by default. */
    usingDefaults: boolean;
}

/** One synced Nextcloud group and the tools switched off for it (`…/nc-integrations/groups`). */
export interface NcIntegrationGroup {
    id: string;
    name: string;
    disabledIntegrations: string[];
    userCount: number;
}

/** `GET /auth/me/active-features` (auth/admin/featureAccessRoutes.js), the beta half. */
export interface ActiveFeatures {
    orgId: string | null;
    allowedBetaFeatures: string[];
    enabledBetaFeatures: string[];
    /** Cloud: the subscription plan decides the betas; the switches are read-only. */
    betaGoverned: boolean;
}
