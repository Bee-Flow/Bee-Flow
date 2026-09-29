/**
 * The /app/settings/* segment space — one owner, the way appRoutes.js owns
 * /app/*.
 *
 * pageFromPath stops at 'settings': everything below the second segment used
 * to be decided by three tables and two readers living inside
 * pages/AdvancedSettings.jsx, next to 800 lines of screen. That is where G3
 * came from — a top-level tab and a group parent competing for the same
 * segment, with the winner decided by the order of two `if`s halfway down a
 * component. The tables live here now so a segment question can be answered
 * (and frozen) without reading the screen.
 *
 * Three kinds of segment, and the difference is the whole point:
 *
 *   1. TOP-LEVEL TABS — /app/settings/<id>. The segment IS the tab id; there
 *      is no rename layer. Renaming one is a route move (see the MOVE_HINT in
 *      appRoutes.test.js), and the old segment stays alive in
 *      SETTINGS_LEGACY_SEGMENT_ALIASES.
 *   2. GROUP PARENTS — 'account' and 'organisation'. These are NOT tabs: they
 *      are the parents of the consumer and organisation sub-tabs, and they own
 *      their segment permanently (G3).
 *   3. LEGACY ALIASES — segments that moved, kept parsing forever.
 *
 * Frozen shapes below this file (server/core/appPaths.js mints them, and
 * settingsRoutes.test.js pins them): /app/settings/account/license and
 * /app/settings/organisation/license are the Stripe checkout return URLs
 * (BFSF-244 — the ?tab= form dropped the payer on Preferences),
 * /app/settings/help_support and /app/settings/learning are notification
 * links. None of them may drift.
 */

/* ── Top-level tabs: /app/settings/<id> ──────────────────────────────────── */
// The source of the settings nav, not a copy of it. 'security' was missing
// here while it sat in the nav list and in the phone subset, so
// /app/settings/security fell through to Preferences and clicking Security
// changed nothing in the address bar (G1) — a divergence that was possible
// because these were two hand-written literals. pages/settings/
// settingsNavItems.jsx now BUILDS its rows (and the phone subset) from this
// list, in this order, so a section that renders always has an address and the
// order of the sidebar is the order below. Adding a section starts here.
export const SETTINGS_TOP_LEVEL_TAB_IDS = [
    'preferences',
    'appearance',
    'security',
    'memory',
    'integrations',
    'learning',
    'help_support',
];

/* ── Group parents: the two segments a tab may never claim (G3) ──────────── */
// 'account' is the parent of the consumer sub-tabs and 'organisation' of the
// org sub-tabs, and both branches are matched BEFORE the top-level lookup — so
// a top-level tab that took one of these names would simply never resolve.
//
// This bites exactly where the redesign points: G2 renames the first subnav
// row from 'Preferences' to 'Account'. That is a LABEL change. The row keeps
// the segment 'preferences', because /app/settings/account/license is a Stripe
// return URL that has been minted into payment receipts. Swapping the branch
// order to let a tab win instead would strand those.
export const SETTINGS_GROUP_SEGMENTS = ['account', 'organisation'];

/* ── Legacy aliases: segments that moved and kept parsing ────────────────── */
// Simple Mode used to be its own section at /app/settings/simple-mode; it is a
// single toggle inside Preferences now. This is where a renamed segment lands
// — the settings-level equivalent of pageFromPath's alias branches, and just
// as permanent: a bookmark does not expire.
export const SETTINGS_LEGACY_SEGMENT_ALIASES = { 'simple-mode': 'preferences' };

/* ── Consumer sub-tabs: /app/settings/account/<sub> ──────────────────────── */
// Internal ids stay `consumer_*` (they gate on isConsumerAccount); the URL
// says what the user sees. The 'account' parent is what keeps 'integrations'
// here from colliding with the top-level 'integrations' tab.
export const SETTINGS_ACCOUNT_ID_TO_URL = {
    consumer_license: 'license',
    consumer_privacy: 'privacy',
    consumer_usage: 'usage',
    consumer_integrations: 'integrations',
    consumer_beta: 'beta',
};
const ACCOUNT_URL_TO_ID = Object.fromEntries(
    Object.entries(SETTINGS_ACCOUNT_ID_TO_URL).map(([id, url]) => [url, id]),
);

/* ── Organisation sub-tabs: /app/settings/organisation/<sub> ─────────────── */
export const SETTINGS_ORG_ID_TO_URL = {
    license: 'license',
    auth: 'auth',
    privacy: 'privacy',
    encryption: 'encryption',
    info: 'info',
    org_usage: 'usage',
    org_compliance: 'compliance',
    org_users: 'users',
    org_academy: 'academy',
    org_integrations: 'integrations',
    org_github_sync: 'github-sync',
    org_nextcloud_sync: 'nextcloud-sync',
    org_meeting_templates: 'meeting-templates',
    org_azure: 'azure',
};
const ORG_URL_TO_ID = Object.fromEntries(
    Object.entries(SETTINGS_ORG_ID_TO_URL).map(([id, url]) => [url, id]),
);

/** The tab id a settings URL opens on, or null when the path is not settings. */
export function settingsTabFromPath(pathname = window.location.pathname) {
    const parts = String(pathname || '').replace(/^\/+|\/+$/g, '').split('/');
    // Expecting 'app', 'settings', …
    if (parts[0] !== 'app' || parts[1] !== 'settings') return null;
    const seg = parts[2];
    if (!seg) return 'preferences';
    // Group parents first — see SETTINGS_GROUP_SEGMENTS for why this order is
    // not negotiable.
    if (seg === 'organisation') return ORG_URL_TO_ID[parts[3]] || 'license';
    if (seg === 'account') return ACCOUNT_URL_TO_ID[parts[3]] || 'consumer_license';
    if (SETTINGS_LEGACY_SEGMENT_ALIASES[seg]) return SETTINGS_LEGACY_SEGMENT_ALIASES[seg];
    if (SETTINGS_TOP_LEVEL_TAB_IDS.includes(seg)) return seg;
    // An unknown segment opens the first section rather than an error screen:
    // the address bar is a place people type in.
    return 'preferences';
}

/** The canonical address of a tab id — the inverse of settingsTabFromPath. */
export function settingsPathForTab(tabId) {
    if (SETTINGS_TOP_LEVEL_TAB_IDS.includes(tabId)) return `/app/settings/${tabId}`;
    const accountUrl = SETTINGS_ACCOUNT_ID_TO_URL[tabId];
    if (accountUrl) return `/app/settings/account/${accountUrl}`;
    const orgUrl = SETTINGS_ORG_ID_TO_URL[tabId];
    if (orgUrl) return `/app/settings/organisation/${orgUrl}`;
    return '/app/settings';
}

/**
 * Org deep segments: /app/settings/organisation/<sub>/<seg1>/<seg2>.
 * settingsTabFromPath only resolves the sub-tab (parts[3]); these two extra
 * segments drive ComplianceHub's activeSection / focusCheckId and
 * UsageSection's initialReport (usage/safety).
 */
export function settingsOrgDeepSegsFromPath(pathname = window.location.pathname) {
    const parts = String(pathname || '').replace(/^\/+|\/+$/g, '').split('/');
    if (parts[0] !== 'app' || parts[1] !== 'settings' || parts[2] !== 'organisation') {
        return { seg1: '', seg2: '' };
    }
    return { seg1: parts[4] || '', seg2: parts[5] ? decodeURIComponent(parts[5]) : '' };
}
