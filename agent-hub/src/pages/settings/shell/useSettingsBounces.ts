import { useEffect } from 'react';
import { MOBILE_VISIBLE_TAB_SET } from './settingsShellData';

export interface SettingsBounceFacts {
    isSimpleMode: boolean;
    activeTab: string;
    setActiveTab: (id: string) => void;
    isSelfHosted: boolean;
    entitlementsLoading: boolean;
    canUseLearning: boolean;
    entitlementsUnknown: boolean;
    projectsOn: boolean;
    isMobile: boolean;
    phoneExemptTab: boolean;
}

/** The redirects to Preferences for a tab this person cannot (or may no longer) see. */
export function useSettingsBounces({
    isSimpleMode, activeTab, setActiveTab, isSelfHosted, entitlementsLoading, canUseLearning, entitlementsUnknown, projectsOn, isMobile, phoneExemptTab,
}: SettingsBounceFacts): void {
    // Simple Mode collapses the settings sidebar to just Preferences. If the
    // user arrives on a deep link (or toggles ON while on another section),
    // bounce them back to Preferences where the toggle now lives.
    useEffect(() => {
        if (isSimpleMode && activeTab !== 'preferences') {
            setActiveTab('preferences');
        }
    }, [isSimpleMode, activeTab, setActiveTab]);

    // Help & Support is hidden on self-hosted — bounce a deep-link/hard-refresh
    // that lands on it (the nav item is filtered out, but the route still exists).
    useEffect(() => {
        if (isSelfHosted && activeTab === 'help_support') {
            setActiveTab('preferences');
        }
    }, [isSelfHosted, activeTab, setActiveTab]);

    // Learning Center without the capability: the welcome email links straight
    // to /app/settings/learning (BFSF-279), so a plan without it would land on
    // an empty panel. Bounce to Preferences once the entitlements are known.
    useEffect(() => {
        if (activeTab === 'learning' && !entitlementsLoading && !canUseLearning) {
            setActiveTab('preferences');
        }
    }, [activeTab, entitlementsLoading, canUseLearning, setActiveTab]);

    // Notifications without Projects: every switch on it is a project event.
    // The segment keeps parsing; it lands on Preferences once the licence
    // snapshot is known (not while it loads, like the Learning Center bounce).
    useEffect(() => {
        if (activeTab === 'notifications' && !entitlementsLoading && !entitlementsUnknown && !projectsOn) {
            setActiveTab('preferences');
        }
    }, [activeTab, entitlementsLoading, entitlementsUnknown, projectsOn, setActiveTab]);

    // Mobile: bounce hidden tabs (Connections, Learning Center, org/account
    // sub-tabs) to Preferences. Covers deep-links/hard-refresh to e.g.
    // /app/settings/connections or /app/settings/organisation/* and a resize
    // that crosses the breakpoint while sitting on a now-hidden tab. The two
    // licence pages in phoneExemptTab stay, so a subscribe redirect or a
    // Stripe return still lands somewhere usable.
    useEffect(() => {
        if (!isMobile) return;
        if (phoneExemptTab) return;
        if (!MOBILE_VISIBLE_TAB_SET.has(activeTab)) {
            setActiveTab('preferences');
        }
    }, [isMobile, activeTab, phoneExemptTab, setActiveTab]);
}
