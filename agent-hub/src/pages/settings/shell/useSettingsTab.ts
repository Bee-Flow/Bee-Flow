import { useCallback, useEffect, useState } from 'react';
import {
    settingsTabFromPath,
    settingsPathForTab,
    settingsOrgDeepSegsFromPath,
} from '../../../authedApp/settingsRoutes';
import type { OrgDeepSegs } from './useComplianceNavigation';

/**
 * The active settings tab, kept in sync with the URL: /app/settings/{section}
 * or /app/settings/organisation/{sub}. Back/forward buttons just work.
 * `activeTab` can be a top-level id OR an org sub-item id (e.g. 'license', 'org_users').
 */
export function useSettingsTab() {
    const [activeTab, setActiveTabState] = useState<string>(() => settingsTabFromPath() || 'preferences');
    // Extra path segments below the Compliance sub-tab (section + check id).
    const [orgDeepSegs, setOrgDeepSegs] = useState<OrgDeepSegs>(() => settingsOrgDeepSegsFromPath());
    const setActiveTab = useCallback((id: string) => {
        setActiveTabState(id);
        setOrgDeepSegs({ seg1: '', seg2: '' });
        const url = settingsPathForTab(id);
        if (window.location.pathname !== url) {
            window.history.pushState({}, '', url);
        }
    }, []);
    useEffect(() => {
        const onPop = () => {
            const tab = settingsTabFromPath();
            if (tab) setActiveTabState(tab);
            setOrgDeepSegs(settingsOrgDeepSegsFromPath());
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    return { activeTab, setActiveTab, setActiveTabState, orgDeepSegs, setOrgDeepSegs };
}
