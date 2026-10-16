import React from 'react';
import type { ReactNode } from 'react';
import OrgAzureConfigPanel from '../../../components/integrations/azure/index';
import { RequireTier } from '../../../components/licensing/LicenseContext';
import AppearanceSection from '../AppearanceSection';
import ConsumerBetaFeaturesSection from '../ConsumerBetaFeaturesSection';
import ConsumerIntegrationsSection from '../ConsumerIntegrationsSection';
import ConsumerLicenseSection from '../ConsumerLicenseSection';
import ConsumerPrivacySection from '../ConsumerPrivacySection';
import ConsumerUsageSection from '../ConsumerUsageSection';
import HelpSupportSection from '../HelpSupportSection';
import IntegrationsSection from '../IntegrationsSection';
import LearningCenterSection from '../LearningCenterSection';
import MemorySection from '../MemorySection';
import NotificationsSection from '../NotificationsSection';
import OrganisationSection from '../OrganisationSection';
import PreferencesSection from '../PreferencesSection';
import type { MemoryStats } from '../../../components/knowledge/memory/memoryTypes';
import type { PreferencesAgent } from '../PreferencesSection.types';
import SecuritySection from '../SecuritySection';
import { MOBILE_VISIBLE_TAB_SET } from './settingsShellData';
import type { SettingsStatuses, SettingsUser } from './settingsShellTypes';
import type { OrgDeepSegs } from './useComplianceNavigation';

/** Everything the section switch reads from the settings shell. */
export interface SettingsContentContext {
    user?: SettingsUser | null;
    activeTab: string;
    setActiveTab: (id: string) => void;
    isMobile: boolean;
    phoneExemptTab: boolean;
    isOrgSubTab: boolean;
    canSeeOrg: boolean;
    canSeeCompliance: boolean;
    canUseLearning: boolean;
    isConsumerAccount: boolean;
    isSelfHosted: boolean;
    projectsOn: boolean;
    entitlementsUnknown: boolean;
    orgDeepSegs: OrgDeepSegs;
    /** The Compliance Center, built by the shell (ComplianceHub is JavaScript). */
    complianceHub: ReactNode;
    defaultAgentMode: string;
    setDefaultAgentMode: (mode: string) => void;
    defaultAgentId: string;
    setDefaultAgentId: (id: string) => void;
    agents: PreferencesAgent[];
    onLogout?: () => void;
    onUpdateUser?: (patch: Partial<SettingsUser>) => void;
    memoryStats: MemoryStats | null;
    memoryStatsStatus: 'loading' | 'ok' | 'error';
    fetchMemoryStats: () => void;
    openMemoryPanel: (view?: string) => void;
    statuses: SettingsStatuses;
    handleIntegrationSaved: (key: string) => void;
}

/** Maps an org sub-tab id to the activeSection prop OrganisationSection expects. */
function orgActiveSectionFor(activeTab: string, isOrgSubTab: boolean): string {
    return isOrgSubTab
        ? (activeTab === 'org_users' ? 'users' : activeTab === 'org_academy' ? 'academy' : activeTab === 'org_integrations' ? 'integrations' : activeTab === 'org_mcp' ? 'mcp' : activeTab === 'org_mcp_access' ? 'mcp_access' : activeTab === 'org_usage' ? 'usage' : activeTab === 'org_azure' ? 'azure' : activeTab === 'org_github_sync' ? 'github_sync' : activeTab === 'org_nextcloud_sync' ? 'nextcloud_sync' : activeTab === 'org_meeting_templates' ? 'meeting_templates' : activeTab)
        : 'license';
}

/** The panel the active tab opens (null when this person may not see it). */
export function renderSettingsContent(ctx: SettingsContentContext): React.ReactNode {
    const {
        user, activeTab, setActiveTab, isMobile, phoneExemptTab, isOrgSubTab, canSeeOrg, canSeeCompliance, canUseLearning,
        isConsumerAccount, isSelfHosted, projectsOn, entitlementsUnknown, orgDeepSegs, complianceHub,
        defaultAgentMode, setDefaultAgentMode, defaultAgentId, setDefaultAgentId, agents, onLogout, onUpdateUser,
        memoryStats, memoryStatsStatus, fetchMemoryStats, openMemoryPanel, statuses, handleIntegrationSaved,
    } = ctx;
    const orgActiveSection = orgActiveSectionFor(activeTab, isOrgSubTab);
        // Mobile: never render a hidden section's panel (covers the one frame
        // before the bounce effect moves activeTab to Preferences). The two
        // licence pages in phoneExemptTab stay renderable.
        if (isMobile && !MOBILE_VISIBLE_TAB_SET.has(activeTab) && !phoneExemptTab) {
            return null;
        }
        // Compliance is reachable for pure-DPO users too (admin_compliance
        // without org-admin), so it must not sit behind the canSeeOrg branch.
        // Below-enterprise deep links get the standard UpgradePrompt.
        if (activeTab === 'org_compliance') {
            if (!canSeeCompliance) return null;
            return (
                <RequireTier tier="enterprise" feature="compliance_hub_gdpr">
                    {complianceHub}
                </RequireTier>
            );
        }
        if (activeTab === 'org_azure' && canSeeOrg) return <OrgAzureConfigPanel user={user} />;
        if (isOrgSubTab && canSeeOrg) return <OrganisationSection user={user} activeSection={orgActiveSection} usageInitialReport={activeTab === 'org_usage' ? (orgDeepSegs.seg1 || '') : ''} />;
        // Consumer account tabs
        if (activeTab === 'consumer_license' && isConsumerAccount) return <ConsumerLicenseSection user={user} />;
        if (activeTab === 'consumer_privacy' && isConsumerAccount) return <ConsumerPrivacySection />;
        if (activeTab === 'consumer_usage' && isConsumerAccount) return <ConsumerUsageSection />;
        if (activeTab === 'consumer_integrations' && isConsumerAccount) return <ConsumerIntegrationsSection />;
        if (activeTab === 'consumer_beta' && isConsumerAccount) return <ConsumerBetaFeaturesSection />;
        switch (activeTab) {
            case 'preferences': return <PreferencesSection defaultAgentMode={defaultAgentMode} setDefaultAgentMode={setDefaultAgentMode} defaultAgentId={defaultAgentId} setDefaultAgentId={setDefaultAgentId} agents={agents} onLogout={onLogout} user={user} onUpdateUser={onUpdateUser} />;
            case 'appearance': return <AppearanceSection />;
            case 'security': return <SecuritySection />;
            case 'memory': return <MemorySection memoryStats={memoryStats} statsStatus={memoryStatsStatus} onRetryStats={fetchMemoryStats} user={user} onUpdateUser={onUpdateUser} onOpenMemory={openMemoryPanel} onImported={fetchMemoryStats} />;
            case 'notifications': return (projectsOn || entitlementsUnknown) ? <NotificationsSection /> : null;
            case 'integrations': return <IntegrationsSection statuses={statuses} onSaved={handleIntegrationSaved} user={user} />;
            case 'learning': return canUseLearning ? <LearningCenterSection user={user} /> : null;
            // The Learning Center link on that page only where its page opens:
            // not on a phone (desktop-only tab) and not without the plan.
            case 'help_support': return isSelfHosted ? null : (
                <HelpSupportSection
                    showLearningLink={canUseLearning && !isMobile}
                    onOpenLearning={() => setActiveTab('learning')}
                />
            );
            default: return null;
        }
}
