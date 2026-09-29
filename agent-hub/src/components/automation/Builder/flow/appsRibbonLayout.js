/**
 * Which app categories the ribbon's Other apps tab treats as a SUITE — the
 * pure half of that tab; the rendering is flow/ribbon/AppsPanels.tsx and the
 * fit (folding the last pills into "More" when the row is too wide) is
 * flow/ribbon/PillRow.tsx over flow/useFitClusters.js.
 *
 * The set of apps is whatever the org has enabled: Google + Microsoft + six
 * one-app categories, or just Webpages. A suite (SUITE_MIN_APPS apps or more)
 * is ONE pill named after the vendor whose dropdown lists its apps, so the
 * row never prints "Calendar" twice for two vendors. The apps of the smaller
 * categories stand on the row one by one, under their full names.
 */

/** A category with this many apps is a suite: one pill of its own. */
export const SUITE_MIN_APPS = 3;

/**
 * The catch-all category for apps the integration catalog does not know
 * (platform tools such as the knowledge-base ingest, an MCP server). Not a
 * vendor, so never a suite: an "Other" pill beside the loose apps would be a
 * catch-all hiding what already stands beside it.
 */
export const OTHER_CATEGORY = 'Other';

/** @typedef {{ category: string, apps: object[] }} CategoryGroup — an orderedAppCategories() entry */

export function isSuite(group) {
    return group?.category !== OTHER_CATEGORY && (group?.apps || []).length >= SUITE_MIN_APPS;
}
