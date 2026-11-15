/**
 * The Microsoft 365 page of an organisation (Microsoft365Panel): the Entra ID
 * group sync, the platform admin's identity links and directory binding, and
 * the Teams meeting-notes setup for the viewer's own organisation. None of
 * the instance-wide Azure form (OpenAI, chat tiers, document processing, the
 * sign-in app) is here any more: each has one home elsewhere.
 */
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationFamily } from '@/api/queries/orgIntegrationAvailability';
import { renderWithClient } from '@/test/render';
import { jsonAnswer } from '@/test/http';
import { availabilityAnswer, availabilityOrgOf } from '@/test/organisationHubKit';
import OrgAzurePage from './index';
import Microsoft365Panel from './Microsoft365Panel';

const SYNC_READ = {
    directoryConfigured: true,
    status: { lastSyncAt: null, lastSyncResult: null, syncedGroups: 0, syncedUsers: 0, errorCount: 0 },
    settings: { destructiveSync: false, autoActivateUsers: true, periodicSync: false, syncIntervalHours: 6 },
};

/** GET /auth/providers: the Microsoft sign-in app, set up on one tenant unless a test says otherwise. */
const SIGN_IN_TENANT = '11111111-2222-3333-4444-555555555555';
const PROVIDERS = { microsoft: { enabled: true, clientId: 'ms-app', tenantId: SIGN_IN_TENANT } };

function stubApi({ off = [] as IntegrationFamily[], providers = PROVIDERS as unknown } = {}): string[] {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const address = String(url);
        asked.push(address);
        const org = availabilityOrgOf(address);
        if (org) return jsonAnswer(availabilityAnswer({ orgId: org, homeOrg: org === 'org-a', off }));
        if (address.includes('/sync-groups/status')) return jsonAnswer(SYNC_READ);
        if (address.includes('/auth/microsoft/link-requests')) return jsonAnswer([]);
        if (address.includes('/auth/microsoft/sync-binding')) return jsonAnswer({});
        if (address.includes('/auth/providers')) return jsonAnswer(providers);
        if (address.includes('/api/teams-setup')) return jsonAnswer({ error: 'not licensed' }, 403);
        return jsonAnswer({});
    }));
    return asked;
}

const ORG_ADMIN = { id: 'u2', permissions: ['org_admin'], organizationId: 'org-a' };
const PLATFORM_ADMIN = { id: 'u1', isAdmin: true, role: 'admin', permissions: ['all'], organizationId: 'org-a' };

const IDENTITY = 'Microsoft identities and directory sync';
const TEAMS_SETUP = 'Teams meeting notes setup';

beforeEach(() => cleanup());
afterEach(() => vi.unstubAllGlobals());

describe('Microsoft365Panel', () => {
    it('shows an organisation admin the group sync and the Teams setup of their own organisation, not the server-wide identity part', async () => {
        stubApi();
        renderWithClient(<Microsoft365Panel user={ORG_ADMIN} orgId="org-a" />);
        expect(await screen.findByRole('heading', { name: 'Microsoft Entra ID group sync' })).toBeInTheDocument();
        const setup = (await screen.findByRole('heading', { name: TEAMS_SETUP })).closest('section') as HTMLElement;
        expect(within(setup).getByTestId('teams-setup-guide')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: IDENTITY })).toBeNull();
    });

    it('adds the identity links and the directory binding for the platform admin', async () => {
        stubApi();
        renderWithClient(<Microsoft365Panel user={PLATFORM_ADMIN} orgId="org-a" />);
        expect(await screen.findByRole('heading', { name: IDENTITY })).toBeInTheDocument();
    });

    it('starts an empty directory binding on the tenant of the Microsoft sign-in app', async () => {
        stubApi();
        renderWithClient(<Microsoft365Panel user={PLATFORM_ADMIN} orgId="org-a" />);
        expect(await screen.findByLabelText('Directory sync tenant GUID')).toHaveValue(SIGN_IN_TENANT);
        expect(screen.getByText('Filled in from the Microsoft sign-in settings. The sync must use the same tenant.')).toBeInTheDocument();
    });

    it('fills in no tenant for a sign-in app open to every Microsoft account', async () => {
        stubApi({ providers: { microsoft: { enabled: true, clientId: 'ms-app', tenantId: 'common' } } });
        renderWithClient(<Microsoft365Panel user={PLATFORM_ADMIN} orgId="org-a" />);
        expect(await screen.findByLabelText('Directory sync tenant GUID')).toHaveValue('');
    });

    it('leaves the identity part out while no Microsoft sign-in app is set up', async () => {
        stubApi({ providers: { microsoft: { enabled: false, clientId: '' } } });
        renderWithClient(<Microsoft365Panel user={PLATFORM_ADMIN} orgId="org-a" />);
        expect(await screen.findByRole('heading', { name: 'Microsoft Entra ID group sync' })).toBeInTheDocument();
        await screen.findByText('Never synced');
        expect(screen.queryByRole('heading', { name: IDENTITY })).toBeNull();
    });

    it('shows the Teams setup of another organisation only as a notice, and asks nothing about it', async () => {
        const asked = stubApi();
        renderWithClient(<Microsoft365Panel user={PLATFORM_ADMIN} orgId="org-b" />);
        const setup = (await screen.findByRole('heading', { name: TEAMS_SETUP })).closest('section') as HTMLElement;
        expect(within(setup).getByTestId('admin-home-org-only')).toBeInTheDocument();
        expect(screen.queryByTestId('teams-setup-guide')).toBeNull();
        expect(asked.some(a => a.includes('/api/teams-setup'))).toBe(false);
        // The group sync follows the chosen organisation.
        expect(asked.some(a => a.includes('/api/org-azure-config/org-b/sync-groups/status'))).toBe(true);
    });

    it('leaves the Teams setup out for an organisation without Meeting Notes', async () => {
        stubApi({ off: ['meetingNotes'] });
        renderWithClient(<Microsoft365Panel user={ORG_ADMIN} orgId="org-a" />);
        expect(await screen.findByRole('heading', { name: 'Microsoft Entra ID group sync' })).toBeInTheDocument();
        // Wait for the availability answer before deciding.
        await screen.findByText('Never synced');
        expect(screen.queryByRole('heading', { name: TEAMS_SETUP })).toBeNull();
    });

    it('leaves the Teams setup out when Microsoft is not available to the organisation, as the Teams card on Meeting notes does', async () => {
        stubApi({ off: ['microsoft'] });
        renderWithClient(<Microsoft365Panel user={ORG_ADMIN} orgId="org-a" />);
        expect(await screen.findByRole('heading', { name: 'Microsoft Entra ID group sync' })).toBeInTheDocument();
        await screen.findByText('Never synced');
        expect(screen.queryByRole('heading', { name: TEAMS_SETUP })).toBeNull();
    });

    it('carries none of the instance-wide Azure form, and asks for none of it', async () => {
        const asked = stubApi();
        renderWithClient(<OrgAzurePage user={PLATFORM_ADMIN} />);
        expect(await screen.findByRole('heading', { name: 'Microsoft Entra ID group sync' })).toBeInTheDocument();
        for (const gone of ['Azure OpenAI', 'Chat Model Tiers', 'Document Processing', 'Microsoft SSO']) {
            expect(screen.queryByText(gone)).toBeNull();
        }
        expect(asked.some(a => /\/api\/org-azure-config\/[^/]+$/.test(new URL(a, 'http://x').pathname))).toBe(false);
    });
});
