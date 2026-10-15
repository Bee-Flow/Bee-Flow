import { NAV_ITEMS, MOBILE_VISIBLE_TOP_TABS, MOBILE_EXTRA_TABS, SETTINGS_RESOURCE_TABS } from '../settingsNavItems';
import type { NavRow } from './SettingsNav';

/* On phones the settings surface is trimmed to user-only sections: Connections
 * (integrations), Learning Center (learning) and the whole Organisation section
 * are hidden. Both the nav rows and this subset come from
 * settings/settingsNavItems.jsx, which derives them from
 * SETTINGS_TOP_LEVEL_TAB_IDS — a nav row and its address cannot drift apart
 * here anymore, which is what G1 was.
 *
 * MOBILE_EXTRA_TABS is the one deliberate hole in "no org sections on a
 * phone": 'org_compliance' is an org SUB-tab, so it is not in
 * MOBILE_VISIBLE_TOP_TABS and never will be, but the Compliance Center has a
 * phone frame of its own and a DPO carries its deadlines around. It is let
 * through the two gates that read this set (the bounce effect and
 * renderContent) and rendered as a top-level row below, while the Organisation
 * accordion around it stays hidden. Both lists are decided in
 * settingsNavItems.jsx; this file only unions them. */
export const MOBILE_VISIBLE_TAB_SET: ReadonlySet<string> = new Set([...MOBILE_VISIBLE_TOP_TABS, ...MOBILE_EXTRA_TABS]);

/** What decides which top-level rows a person gets (see getVisibleNavItems). */
export interface NavVisibility {
    isSimpleMode: boolean;
    canUseLearning: boolean;
    projectsOn: boolean;
    entitlementsUnknown: boolean;
    isSelfHosted: boolean;
    isMobile: boolean;
}

/** The top-level rows this person gets (Simple Mode keeps only the first). */
export function getVisibleNavItems({ isSimpleMode, canUseLearning, projectsOn, entitlementsUnknown, isSelfHosted, isMobile }: NavVisibility): NavRow[] {
    return isSimpleMode ? [NAV_ITEMS[0]] : NAV_ITEMS.filter(item => {
        if (item.id === 'learning' && !canUseLearning) return false;
        // Every switch on Notifications is a project event.
        if (item.id === 'notifications' && !projectsOn && !entitlementsUnknown) return false;
        // Help & Support is a Bee Flow Cloud surface (the support
        // inbox talks to the Bee Flow team) — hidden on self-hosted.
        if (item.id === 'help_support' && isSelfHosted) return false;
        // Mobile hides Connections + Learning Center.
        if (isMobile && !MOBILE_VISIBLE_TAB_SET.has(item.id)) return false;
        return true;
    });
}

/** Splits the rows into the settings and the resources below a thin rule (SETTINGS_RESOURCE_TABS). */
export function splitNavRows(visibleNavItems: NavRow[]): { settingsNavRows: NavRow[]; resourceNavRows: NavRow[] } {
    return {
        settingsNavRows: visibleNavItems.filter(item => !SETTINGS_RESOURCE_TABS.includes(item.id)),
        resourceNavRows: visibleNavItems.filter(item => SETTINGS_RESOURCE_TABS.includes(item.id)),
    };
}
