/**
 * The settings sidebar rows — DERIVED from the URL table, not listed a second
 * time.
 *
 * G1 was exactly one divergence: 'security' sat in the nav list and in the
 * mobile subset while SETTINGS_TOP_LEVEL_TAB_IDS omitted it, so the row
 * rendered, the click left the address bar untouched, and
 * /app/settings/security opened Preferences. Adding the missing id repaired
 * the symptom; the cause was that a nav row and an address were two
 * hand-written literals with nothing comparing them, so the next section added
 * to the nav would reproduce it.
 *
 * So the rows are built FROM SETTINGS_TOP_LEVEL_TAB_IDS (authedApp/
 * settingsRoutes.js), in that order, and the phone subset is that same list
 * minus the desktop-only ids. A section can no longer be added to this screen
 * without an address: its id goes in settingsRoutes.js first, and the
 * presentation for it goes below. settingsRoutes.test.js pins both directions.
 */
import { GraduationCap, LifeBuoy, Palette } from 'lucide-react';
import React from 'react';
import { SETTINGS_TOP_LEVEL_TAB_IDS } from '../../authedApp/settingsRoutes';

/* ── Presentation per tab id: label key + icon, nothing about routing ────── */
const NAV_ROW_BY_ID = {
    preferences: {
        labelKey: 'settings.preferences',
        icon: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="15" height="15"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>,
    },
    appearance: {
        labelKey: 'settings.appearance',
        icon: <Palette width="15" height="15" strokeWidth={1.75} />,
    },
    security: {
        labelKey: 'settings.security',
        icon: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="15" height="15"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>,
    },
    memory: {
        labelKey: 'settings.memory',
        icon: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="15" height="15"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>,
    },
    integrations: {
        labelKey: 'settings.connections',
        icon: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="15" height="15"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>,
    },
    learning: {
        labelKey: 'settings.learning_center',
        icon: <GraduationCap width="15" height="15" strokeWidth={1.75} />,
    },
    help_support: {
        labelKey: 'settings.help_support',
        icon: <LifeBuoy width="15" height="15" strokeWidth={1.75} />,
    },
};

// The other direction of the same coupling: a presentation row whose id is not
// an addressable segment is never built into NAV_ITEMS, so it renders nowhere
// and says nothing. settingsRoutes.test.js compares these keys to
// SETTINGS_TOP_LEVEL_TAB_IDS so that orphan is loud instead of invisible.
export const SETTINGS_NAV_ROW_IDS = Object.keys(NAV_ROW_BY_ID);

/* ── The sections a phone does not get ───────────────────────────────────── */
// Connections and the Learning Center are desktop surfaces (the whole
// Organisation group is hidden on phones separately — those ids are not
// top-level tabs at all). This is the ONLY place the phone trim is decided.
export const SETTINGS_DESKTOP_ONLY_TABS = ['integrations', 'learning'];

/**
 * The top-level ids that stay visible on a phone. Subtracted from the frozen
 * list rather than typed out, so "a strict subset of SETTINGS_TOP_LEVEL_TAB_IDS"
 * is how it is built instead of a claim in a comment that nothing checks — the
 * shape of G1.
 */
export const MOBILE_VISIBLE_TOP_TABS = SETTINGS_TOP_LEVEL_TAB_IDS
    .filter(id => !SETTINGS_DESKTOP_ONLY_TABS.includes(id));

/**
 * Ids that a phone reaches WITHOUT being top-level tabs.
 *
 * The Organisation accordion stays hidden on phones, but Compliance is not an
 * org-admin convenience: a DPO carries a deadline clock in their pocket, and
 * the Compliance Center has a phone frame of its own (ComplianceMobile). So
 * 'org_compliance' — an org SUB-tab id, addressable at
 * /app/settings/organisation/compliance — is let through the phone filters
 * while its group is not, and AdvancedSettings renders it as a top-level row.
 *
 * Kept here rather than in the screen so the phone trim stays decided in ONE
 * place (the comment above MOBILE_VISIBLE_TOP_TABS): the screen unions the
 * two lists into MOBILE_VISIBLE_TAB_SET and never adds a third rule.
 */
export const MOBILE_EXTRA_TABS = ['org_compliance'];

// An addressable segment with no presentation row is the mirror image of G1:
// the URL resolves and the way in is missing. It renders as a visibly wrong
// row (and shouts in the console) instead of throwing at import time, which
// would take the whole settings screen down; settingsRoutes.test.js is what
// turns it red before it ships.
const FALLBACK_ICON = <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="15" height="15"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;

/**
 * The nav rows, in URL order. NAV_ITEMS[0] is the first segment of
 * SETTINGS_TOP_LEVEL_TAB_IDS ('preferences') — Simple Mode renders that one
 * row alone, and Preferences is also where every bounce (simple mode,
 * self-hosted, phone, unknown segment) lands.
 */
export const NAV_ITEMS = SETTINGS_TOP_LEVEL_TAB_IDS.map((id) => {
    const row = NAV_ROW_BY_ID[id];
    if (row) return { id, ...row };
    console.error(`[Settings] '${id}' is addressable but has no nav row — add one in settingsNavItems.jsx`);
    return { id, labelKey: `settings.${id}`, icon: FALLBACK_ICON };
});
