/**
 * Azure (self-hosted only), GitHub Sync and the org's meeting templates
 * against canned server answers: the section bodies each save sends — a
 * secret only when one was typed — the group sync, who is turned away, and
 * that a new org template starts on the organisation scope.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { AzureModelsScreen } from './AzureModelsScreen';
import { AzureScreen } from './AzureScreen';
import { AzureSsoScreen } from './AzureSsoScreen';
import { GithubSyncScreen } from './GithubSyncScreen';
import { MeetingTemplatesScreen } from './MeetingTemplatesScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockOrg = { orgId: 'o1', isOrgAdmin: true, isSelfHosted: true, isNcOrg: false };
const mockAccess = { isSuperAdmin: false, orgRole: 'org_admin' };

jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'me', organizationId: 'o1' } }) }));
jest.mock('@/features/org', () => ({ ...jest.requireActual('@/features/org'), useOrgContext: () => mockOrg }));
jest.mock('@/core/access', () => ({
    ...jest.requireActual('@/core/access'),
    useAccess: () => mockAccess,
    holds: () => true,
    hasLicenseFeature: () => true,
}));

const AZURE = {
    azureEndpoint: 'https://acme.openai.azure.com',
    hasAzureApiKey: true,
    azureModels: 'gpt-4.1, gpt-5-mini',
    chatModelTiers: { fast: { modelId: 'gpt-4.1', label: 'Fast', topP: 1 } },
    ssoClientId: 'client-1',
    hasSsoClientSecret: true,
    ssoTenantId: '0c1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8',
    autoApproveSSO: false,
    groupSyncSettings: { destructiveSync: false, autoActivateUsers: true, periodicSync: false, syncIntervalHours: 6 },
    groupSyncStatus: { lastSyncAt: null, lastSyncResult: null, syncedGroups: 0, syncedUsers: 0 },
};

let answers: Record<string, unknown> = {};

beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockOrg, { orgId: 'o1', isOrgAdmin: true, isSelfHosted: true, isNcOrg: false });
    Object.assign(mockAccess, { isSuperAdmin: false, orgRole: 'org_admin' });
    answers = { '/api/org-azure-config/o1': AZURE };
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(answers[path] ?? null));
    (api.post as jest.Mock).mockResolvedValue({ ok: true });
    (api.put as jest.Mock).mockResolvedValue({ ok: true });
    (api.delete as jest.Mock).mockResolvedValue({ ok: true });
});

describe('Azure', () => {
    it('lists the four sections, each opening its own screen', async () => {
        await renderScreen(<AzureScreen />);
        await fireEvent.press(await screen.findByTestId('azure-sso'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/azure/sso');
    });

    it('says a cloud deployment’s Azure belongs to the platform, and asks nothing', async () => {
        mockOrg.isSelfHosted = false;
        await renderScreen(<AzureScreen />);
        expect(screen.getByText('Azure Configuration is for self-hosted installations')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalled();
    });

    it('turns the legacy admin role away, as the route does', async () => {
        mockAccess.orgRole = 'admin';
        await renderScreen(<AzureScreen />);
        expect(api.get).not.toHaveBeenCalled();
    });

    it('saves SSO without the stored secret, and with a new one once typed', async () => {
        await renderScreen(<AzureSsoScreen />);
        await fireEvent(await screen.findByTestId('azure-sso-auto-approve'), 'valueChange', true);
        expect(screen.getByText(/Security notice/)).toBeTruthy();
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/org-azure-config/o1', {
                section: 'sso',
                ssoClientId: 'client-1',
                ssoTenantId: '0c1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8',
                autoApproveSSO: true,
            }),
        );
        await fireEvent.changeText(screen.getByTestId('azure-sso-secret'), ' s3cret ');
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/api/org-azure-config/o1', expect.objectContaining({ ssoClientSecret: 's3cret' })));
    });

    it('holds a tenant the server would refuse, and warns about "common"', async () => {
        await renderScreen(<AzureSsoScreen />);
        await fireEvent.changeText(await screen.findByTestId('azure-sso-tenant'), 'contoso.com');
        expect(screen.getByText(/The tenant is your directory GUID/)).toBeTruthy();
        await fireEvent.changeText(screen.getByTestId('azure-sso-tenant'), 'common');
        expect(screen.getByText(/Tenant ID is set to "common"/)).toBeTruthy();
    });

    it('runs a group sync and saves a sync setting on its own', async () => {
        (api.post as jest.Mock).mockResolvedValue({ ok: true, synced: { groups: 2, users: 3 }, details: ['✓ Authenticated successfully'], errors: [] });
        (api.put as jest.Mock).mockResolvedValue({ ok: true, settings: { ...AZURE.groupSyncSettings, periodicSync: true } });
        await renderScreen(<AzureSsoScreen />);
        await fireEvent.press(await screen.findByTestId('azure-sync-now'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/org-azure-config/o1/sync-groups'));
        expect(await screen.findByText('Sync completed: 2 group(s), 3 new user(s)')).toBeTruthy();
        // The run re-reads the configuration, so the status is the server's.
        await waitFor(() => expect((api.get as jest.Mock).mock.calls.filter(([p]) => p === '/api/org-azure-config/o1')).toHaveLength(2));
        await fireEvent(screen.getByTestId('azure-sync-periodic'), 'valueChange', true);
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/org-azure-config/o1/sync-groups/settings', { periodicSync: true }));
        expect(await screen.findByText('Weekly')).toBeTruthy();
    });

    it('confirms destructive sync before switching it on, and switches it off at once', async () => {
        (api.put as jest.Mock).mockResolvedValue({ ok: true, settings: { ...AZURE.groupSyncSettings, destructiveSync: true } });
        await renderScreen(<AzureSsoScreen />);
        expect(await screen.findByText('Saved as you switch')).toBeTruthy();
        await fireEvent(screen.getByTestId('azure-sync-destructive'), 'valueChange', true);
        expect(await screen.findByText('Switch on')).toBeTruthy();
        await fireEvent.press(screen.getByText('Cancel'));
        await waitFor(() => expect(screen.queryByText('Switch on')).toBeNull());
        expect(api.put).not.toHaveBeenCalled();

        await fireEvent(screen.getByTestId('azure-sync-destructive'), 'valueChange', true);
        await fireEvent.press(await screen.findByText('Switch on'));
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/org-azure-config/o1/sync-groups/settings', { destructiveSync: true }));
    });

    it('switches destructive sync off without asking', async () => {
        answers['/api/org-azure-config/o1'] = { ...AZURE, groupSyncSettings: { ...AZURE.groupSyncSettings, destructiveSync: true } };
        await renderScreen(<AzureSsoScreen />);
        await fireEvent(await screen.findByTestId('azure-sync-destructive'), 'valueChange', false);
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/org-azure-config/o1/sync-groups/settings', { destructiveSync: false }));
        expect(screen.queryByText('Switch on')).toBeNull();
    });

    it('warns about a lock-out only while there is an unsaved change, and keeps the guide behind one row', async () => {
        await renderScreen(<AzureSsoScreen />);
        await screen.findByTestId('azure-sso-tenant');
        expect(screen.queryByText(/Changing these settings can lock users out/)).toBeNull();
        expect(screen.queryByText(/Required Azure Permissions/i)).toBeNull();
        await fireEvent.changeText(screen.getByTestId('azure-sso-client-id'), 'client-2');
        expect(screen.getByText(/Changing these settings can lock users out/)).toBeTruthy();
        await fireEvent.press(screen.getByTestId('azure-sso-guide'));
        expect(screen.getByText(/Required Azure Permissions/i)).toBeTruthy();
        expect(screen.getByTestId('azure-sso-portal')).toBeTruthy();
    });

    it('shows why a run failed', async () => {
        (api.post as jest.Mock).mockResolvedValue({ ok: false, synced: { groups: 0, users: 0 }, details: [], errors: ['Insufficient privileges'] });
        await renderScreen(<AzureSsoScreen />);
        await fireEvent.press(await screen.findByTestId('azure-sync-now'));
        expect(await screen.findByText('Sync failed: Insufficient privileges')).toBeTruthy();
    });

    it('saves the four tiers over their untouched fields', async () => {
        await renderScreen(<AzureModelsScreen />);
        await fireEvent.press(await screen.findByTestId('azure-tier-fast'));
        await fireEvent.press(screen.getByText('gpt-5-mini'));
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() => expect(api.put).toHaveBeenCalled());
        const [, body] = (api.put as jest.Mock).mock.calls[0] as [string, { section: string; chatModelTiers: Record<string, unknown> }];
        expect(body.section).toBe('chatModels');
        expect(Object.keys(body.chatModelTiers)).toEqual(['fast', 'thinking', 'writer', 'pro']);
        expect(body.chatModelTiers.fast).toEqual({ modelId: 'gpt-5-mini', label: 'Fast', topP: 1 });
    });
});

describe('GithubSyncScreen', () => {
    it('sends someone without a GitHub connection to Integrations', async () => {
        answers['/api/integrations/github-sync/status'] = { configured: false, githubConnected: false };
        await renderScreen(<GithubSyncScreen />);
        await fireEvent.press(await screen.findByText('Integrations'));
        expect(mockRouter.push).toHaveBeenCalledWith('/integrations');
    });

    it('configures a repository with trimmed names and main as the default branch', async () => {
        answers['/api/integrations/github-sync/status'] = { configured: false, githubConnected: true };
        await renderScreen(<GithubSyncScreen />);
        await fireEvent.press(await screen.findByText('Configure Repository'));
        await fireEvent.changeText(screen.getByTestId('gh-owner'), ' bee-flow ');
        await fireEvent.changeText(screen.getByTestId('gh-name'), 'agent-configs');
        await fireEvent.changeText(screen.getByTestId('gh-branch'), '');
        await fireEvent.press(screen.getByText('Connect Repository'));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/api/integrations/github-sync/configure', {
                repoOwner: 'bee-flow',
                repoName: 'agent-configs',
                branch: 'main',
                autoSync: false,
            }),
        );
    });

    it('pushes everything from a configured repository', async () => {
        answers['/api/integrations/github-sync/status'] = {
            configured: true,
            githubConnected: true,
            config: { repoOwner: 'bee-flow', repoName: 'agent-configs', branch: 'main' },
            overview: { synced: 3, pending: 1, error: 0, total: 4 },
        };
        (api.post as jest.Mock).mockResolvedValue({ results: { agents: { pushed: 2, skipped: 1 }, skills: { pushed: 0, skipped: 0 } } });
        await renderScreen(<GithubSyncScreen />);
        await fireEvent.press(await screen.findByTestId('gh-push-all'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/integrations/github-sync/push'));
    });
});

describe('MeetingTemplatesScreen', () => {
    it('lists the org’s templates and starts a new one on the organisation scope', async () => {
        answers['/api/summary-templates/org'] = {
            templates: [{ id: 't1', name: 'Board style', scope: 'org', prompt: 'x', isDefault: false }],
            groups: [{ id: 'g1', name: 'Sales' }],
        };
        answers['/api/summary-templates'] = { builtins: [{ id: 'general', name: 'General meeting', prompt: 'Summarise the meeting.' }], custom: [] };
        (api.post as jest.Mock).mockResolvedValue({ id: 't2', name: 'General meeting', scope: 'org' });
        await renderScreen(<MeetingTemplatesScreen />);
        expect(await screen.findByText('Board style')).toBeTruthy();
        await fireEvent.press(screen.getByLabelText('New template…'));
        await fireEvent.press(await screen.findByText('General meeting'));
        await fireEvent.press(screen.getByText('Save template'));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/api/summary-templates', {
                scope: 'org',
                name: 'General meeting',
                prompt: 'Summarise the meeting.',
                isDefault: false,
            }),
        );
    });
});
