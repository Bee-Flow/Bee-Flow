import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import OrgAzureConfigPanel from '@/components/integrations/azure/index';
import GroupSyncPanel from '@/components/integrations/azure/GroupSyncPanel';
import { renderSettingsContent, type SettingsContentContext } from './renderSettingsContent';

const ctx = (over: Partial<SettingsContentContext>): SettingsContentContext => ({
    user: { organizationId: 'org1' },
    activeTab: 'org_azure',
    setActiveTab: vi.fn(),
    isMobile: false,
    phoneExemptTab: false,
    isOrgSubTab: true,
    canSeeOrg: true,
    canSeeCompliance: false,
    canUseLearning: false,
    isConsumerAccount: false,
    isSelfHosted: true,
    isPlatformAdmin: false,
    projectsOn: false,
    entitlementsUnknown: false,
    orgDeepSegs: { seg1: '', seg2: '' },
    complianceHub: null,
    defaultAgentMode: 'auto',
    setDefaultAgentMode: vi.fn(),
    defaultAgentId: '',
    setDefaultAgentId: vi.fn(),
    agents: [],
    memoryStats: null,
    memoryStatsStatus: 'ok',
    fetchMemoryStats: vi.fn(),
    openMemoryPanel: vi.fn(),
    statuses: { githubConnected: false },
    handleIntegrationSaved: vi.fn(),
    ...over,
});

describe('renderSettingsContent: the Azure tab', () => {
    // GET/PUT /api/org-azure-config/:orgId answer a platform admin only, so a
    // deep link must not open a panel an org admin can neither load nor save.
    it('opens the organisation\'s group sync, not the Azure panel, for an org admin on a self-hosted install', () => {
        const node = renderSettingsContent(ctx({}));
        expect(isValidElement(node) && node.type).toBe(GroupSyncPanel);
    });

    it('opens nothing for an org admin on cloud, or for someone who cannot see the organisation', () => {
        expect(renderSettingsContent(ctx({ isSelfHosted: false }))).toBeNull();
        expect(renderSettingsContent(ctx({ canSeeOrg: false }))).toBeNull();
    });

    it('opens the Azure panel for a platform admin', () => {
        const node = renderSettingsContent(ctx({ isPlatformAdmin: true }));
        expect(isValidElement(node) && node.type).toBe(OrgAzureConfigPanel);
    });
});
