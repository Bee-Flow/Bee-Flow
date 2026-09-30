/**
 * The integrations hub, the Nextcloud tool switches, n8n's connection and the
 * system knowledge bases, against canned server answers: what each shows,
 * the exact request each action sends, and who is turned away.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { N8nScreen } from './N8nScreen';
import { NcIntegrationsScreen } from './NcIntegrationsScreen';
import { OrgIntegrationsScreen } from './OrgIntegrationsScreen';
import { SystemKnowledgeBasesScreen } from './SystemKnowledgeBasesScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockOrg = { orgId: 'o1', isOrgAdmin: true, isSelfHosted: false, isNcOrg: false };
const mockUser: { id: string; organizationId: string; enabledIntegrations?: string[] } = { id: 'me', organizationId: 'o1' };
const mockAccess = { isSuperAdmin: false, orgRole: 'org_admin' };

jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('@/features/org', () => ({ ...jest.requireActual('@/features/org'), useOrgContext: () => mockOrg }));
jest.mock('@/core/access', () => ({
    ...jest.requireActual('@/core/access'),
    useAccess: () => mockAccess,
    holds: () => true,
    hasLicenseFeature: () => true,
}));

let answers: Record<string, unknown> = {};

beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockOrg, { orgId: 'o1', isOrgAdmin: true, isSelfHosted: false, isNcOrg: false });
    delete mockUser.enabledIntegrations;
    mockAccess.isSuperAdmin = false;
    answers = {};
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(answers[path] ?? null));
    (api.post as jest.Mock).mockResolvedValue({ ok: true });
    (api.put as jest.Mock).mockResolvedValue({ ok: true });
});

describe('OrgIntegrationsScreen', () => {
    it('opens the access matrix on its integration and beta kinds', async () => {
        await renderScreen(<OrgIntegrationsScreen />);
        await fireEvent.press(screen.getByTestId('integrations-access'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/access?kind=integration');
        await fireEvent.press(screen.getByTestId('integrations-beta'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/access?kind=beta');
    });

    it('shows only the settings the org’s allow-list keeps, and Nextcloud for an NC org', async () => {
        mockUser.enabledIntegrations = ['n8n'];
        mockOrg.isNcOrg = true;
        await renderScreen(<OrgIntegrationsScreen />);
        expect(screen.getByTestId('integrations-n8n')).toBeTruthy();
        expect(screen.getByTestId('integrations-nextcloud')).toBeTruthy();
        expect(screen.queryByTestId('integrations-maps')).toBeNull();
        expect(api.get).not.toHaveBeenCalledWith('/ai/config', expect.anything());
    });

    it('saves a Google Maps key, and never reads one back', async () => {
        answers['/ai/config'] = { hasGoogleMapsKey: false };
        await renderScreen(<OrgIntegrationsScreen />);
        await fireEvent.press(await screen.findByTestId('integrations-maps'));
        await fireEvent.changeText(screen.getByTestId('maps-key'), ' AIza-test ');
        await fireEvent.press(screen.getByText('Save changes'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/ai/config', { googleMapsApiKey: 'AIza-test' }));
    });

    it('turns a member away', async () => {
        mockOrg.isOrgAdmin = false;
        await renderScreen(<OrgIntegrationsScreen />);
        expect(screen.getByText('For organisation administrators')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalled();
    });
});

describe('NcIntegrationsScreen', () => {
    beforeEach(() => {
        mockOrg.isNcOrg = true;
        answers = {
            '/auth/admin/o1/nc-integrations': {
                ncCatalog: [
                    { id: 'files', name: 'Files' },
                    { id: 'deck', name: 'Deck' },
                ],
                enabled: ['files'],
            },
            '/auth/admin/o1/nc-integrations/groups': { groups: [{ id: 'g1', name: 'Sales', disabledIntegrations: [], userCount: 4 }] },
        };
    });

    it('saves the org-wide switches together, in the catalogue’s order', async () => {
        await renderScreen(<NcIntegrationsScreen />);
        await fireEvent(await screen.findByTestId('nc-tool-deck'), 'valueChange', true);
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/admin/o1/nc-integrations', { enabled: ['files', 'deck'] }));
    });

    it('switches a tool off for one group at once', async () => {
        await renderScreen(<NcIntegrationsScreen />);
        await fireEvent.press(await screen.findByTestId('nc-group-row-g1'));
        await fireEvent(screen.getByTestId('nc-group-files'), 'valueChange', true);
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/auth/admin/o1/nc-integrations/groups/g1', { disabledIntegrations: ['files'] }),
        );
    });

    it('points to Nextcloud Sync while no groups are synced', async () => {
        answers['/auth/admin/o1/nc-integrations/groups'] = { groups: [] };
        await renderScreen(<NcIntegrationsScreen />);
        await fireEvent.press(await screen.findByTestId('nc-open-sync'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/nextcloud');
    });

    it('asks nothing for an org without a Nextcloud', async () => {
        mockOrg.isNcOrg = false;
        await renderScreen(<NcIntegrationsScreen />);
        expect(api.get).not.toHaveBeenCalled();
    });
});

describe('N8nScreen', () => {
    beforeEach(() => {
        answers = {
            '/ai/n8n/config': { configured: true, n8nUrl: 'https://n8n.acme.nl', hasApiKey: true, workflows: [] },
            '/ai/n8n/diagnostics': {
                org: { n8nConfigured: true, enabledIntegrationsIncludesN8n: false, source: 'org_list' },
                userLevel: { passes: true, reason: 'default' },
                permissions: { modify_n8n_workflows: true },
            },
        };
    });

    it('offers to enable n8n for the org when the access check says it is off', async () => {
        await renderScreen(<N8nScreen />);
        await fireEvent.press(await screen.findByTestId('n8n-enable-org'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/ai/n8n/enable-for-org'));
    });

    it('tests with the stored key and saves the URL without re-sending one', async () => {
        (api.post as jest.Mock).mockResolvedValue({ ok: true, activeWebhookCount: 4 });
        await renderScreen(<N8nScreen />);
        await fireEvent.press(await screen.findByTestId('n8n-test'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/ai/n8n/test', { n8nUrl: 'https://n8n.acme.nl' }));
        await fireEvent.changeText(screen.getByTestId('n8n-url'), 'https://flows.acme.nl');
        await fireEvent.press(screen.getByTestId('n8n-save'));
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/ai/n8n/config', { n8nUrl: 'https://flows.acme.nl' }));
    });
});

describe('SystemKnowledgeBasesScreen', () => {
    const KB = { id: 'kb1', name: 'Dutch law', system_slug: 'kb_law', enabledForOrg: false, allowedForOrg: true };

    it('switches a base on by adding its feature to the org’s active list', async () => {
        answers = {
            '/api/kb/system': { items: [KB] },
            '/auth/me/active-features': { orgId: 'o1', allowedBetaFeatures: ['kb_law'], enabledBetaFeatures: ['other'], betaGoverned: false },
        };
        await renderScreen(<SystemKnowledgeBasesScreen />);
        await fireEvent(await screen.findByTestId('system-kb-kb1-switch'), 'valueChange', true);
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/me/active-features', { betaEnabled: ['other', 'kb_law'] }));
    });

    it('locks the switches where the subscription governs the betas', async () => {
        answers = {
            '/api/kb/system': { items: [KB] },
            '/auth/me/active-features': { orgId: 'o1', enabledBetaFeatures: [], betaGoverned: true },
        };
        await renderScreen(<SystemKnowledgeBasesScreen />);
        expect(await screen.findByText(/your subscription plan decides/)).toBeTruthy();
        expect(screen.getByTestId('system-kb-kb1-switch').props.disabled ?? screen.getByTestId('system-kb-kb1-switch').props.accessibilityState?.disabled).toBe(true);
    });
});
