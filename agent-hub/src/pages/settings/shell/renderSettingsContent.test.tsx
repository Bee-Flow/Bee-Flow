import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import OrgAzureConfigPanel from '@/components/integrations/azure/index';
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
    it('opens nothing for an org admin who is not a platform admin', () => {
        expect(renderSettingsContent(ctx({}))).toBeNull();
    });

    it('opens the Azure panel for a platform admin', () => {
        const node = renderSettingsContent(ctx({ isPlatformAdmin: true }));
        expect(isValidElement(node) && node.type).toBe(OrgAzureConfigPanel);
    });
});
