import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_SCOPES_FALLBACK, isMultiTenantId, isTenantIdValid, logoFileProblem, MAX_LOGO_BYTES } from './sso/MicrosoftSsoTab';
import SSOConfigPanel from './SSOConfigPanel';
import { authFetch } from '@/utils/helpers';

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationMock'));
const hasFeature = vi.fn(() => true);
vi.mock('../../licensing/LicenseContext', () => ({ useLicenseContext: () => ({ hasFeature }) }));
vi.mock('./MicrosoftIdentityPanel', () => ({ default: () => <div data-testid="ms-identity" /> }));

const fetchMock = vi.mocked(authFetch);
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

const PROVIDERS = {
    nextcloud: { enabled: true, url: 'https://cloud.example', clientId: 'nc-id', clientSecretSet: true },
    google: { enabled: false, clientId: '', clientSecretSet: false },
    microsoft: { enabled: false, clientId: 'ms-id', clientSecretSet: false, tenantId: 'common', label: '', logo: '', connections: [] },
};
const putBody = () => {
    const put = fetchMock.mock.calls.find(([url, opts]) => url === '/auth/providers/microsoft' && (opts as RequestInit | undefined)?.method === 'PUT');
    return JSON.parse(String((put?.[1] as RequestInit | undefined)?.body));
};

beforeEach(() => {
    hasFeature.mockReturnValue(true);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url === '/auth/providers') return json(PROVIDERS);
        if (url === '/auth/setup-status') return json({ serverUrl: 'https://flow.example' });
        if (url === '/auth/providers/microsoft' && opts?.method === 'PUT') return json({ message: 'Saved!' });
        return json({}, false);
    });
});
afterEach(cleanup);

describe('SSOConfigPanel', () => {
    it('lists the providers beside the form, the enabled ones counted and Nextcloud selected', async () => {
        const user = userEvent.setup();
        renderWithClient(<SSOConfigPanel />);
        const nav = await screen.findByRole('navigation', { name: 'SSO Providers' });
        const group = within(nav).getByRole('region', { name: 'SSO Providers' });
        expect(within(group).getByText('1')).toBeTruthy();
        expect(within(nav).getByRole('button', { name: /Nextcloud/ }).getAttribute('aria-current')).toBe('true');
        await user.click(within(nav).getByRole('button', { name: /Google/ }));
        expect(within(nav).getByRole('button', { name: /Google/ }).getAttribute('aria-current')).toBe('true');
        expect(await screen.findByText('Google OAuth 2.0')).toBeTruthy();
    });

    it('shows the Nextcloud form with its redirect URI and hides enterprise providers on Community', async () => {
        hasFeature.mockReturnValue(false);
        renderWithClient(<SSOConfigPanel />);
        expect(await screen.findByText('Nextcloud OAuth 2.0')).toBeTruthy();
        expect(screen.getByDisplayValue('https://cloud.example')).toBeTruthy();
        await waitFor(() => expect(screen.getByText('https://flow.example/auth/callback/nextcloud')).toBeTruthy());
        expect(screen.queryByRole('button', { name: /Google/ })).toBeNull();
    });

    it('saves the Microsoft provider with the typed secret and clears it', async () => {
        const user = userEvent.setup();
        renderWithClient(<SSOConfigPanel />);
        await user.click(await screen.findByRole('button', { name: /Microsoft/ }));
        expect(screen.getByText('Microsoft / Azure AD')).toBeTruthy();
        expect(screen.getByTestId('ms-identity')).toBeTruthy();
        const secret = screen.getByPlaceholderText('Client Secret Value');
        await user.type(secret, 's3cret');
        await user.click(screen.getByRole('button', { name: 'admin.sso_save' }));
        await waitFor(() => expect(screen.getByText('Saved!')).toBeTruthy());
        expect(putBody()).toEqual({ clientId: 'ms-id', tenantId: 'common', label: '', logo: '', connections: [], clientSecret: 's3cret' });
        expect((secret as HTMLInputElement).value).toBe('');
    });

    it('renders the identity panel below the Microsoft form, inside the content column', async () => {
        const user = userEvent.setup();
        renderWithClient(<SSOConfigPanel />);
        await user.click(await screen.findByRole('button', { name: /Microsoft/ }));
        const panel = screen.getByTestId('ms-identity');
        const content = screen.getByText('Microsoft / Azure AD').closest('.overflow-y-auto');
        expect(content).not.toBeNull();
        expect(content!.contains(panel)).toBe(true);
    });

    it('sends the primary button text and an added tenant with its own secret', async () => {
        const user = userEvent.setup();
        renderWithClient(<SSOConfigPanel />);
        await user.click(await screen.findByRole('button', { name: /Microsoft/ }));
        await user.type(screen.getByLabelText('Button text'), 'Head office');
        expect(screen.getByText('No additional tenants. Everyone signs in through the app registration above.')).toBeTruthy();
        await user.click(screen.getByTestId('ms-connection-add'));
        const card = screen.getByTestId('ms-connection-0');
        const inputs = card.querySelectorAll('input');
        await user.type(inputs[0], 'Subsidiary');                 // button text
        await user.type(inputs[2], '11111111-1111-1111-1111-111111111111'); // client id (index 1 is the file input)
        await user.type(inputs[3], 'sub-secret');
        await user.type(inputs[4], 'organizations');
        await user.click(screen.getByRole('button', { name: 'admin.sso_save' }));
        await waitFor(() => expect(screen.getByText('Saved!')).toBeTruthy());
        const body = putBody();
        expect(body.label).toBe('Head office');
        expect(body.connections).toHaveLength(1);
        expect(body.connections[0]).toMatchObject({ label: 'Subsidiary', clientId: '11111111-1111-1111-1111-111111111111', clientSecret: 'sub-secret', tenantId: 'organizations', logo: '' });
        expect(body.connections[0].id).toMatch(/^[0-9a-f]{12}$/);
    });

    it('drops a removed tenant from what is saved', async () => {
        fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
            if (url === '/auth/providers') return json({ ...PROVIDERS, microsoft: { ...PROVIDERS.microsoft, connections: [
                { id: 'sub', label: 'Subsidiary', logo: '', clientId: 'sub-id', tenantId: 'common', clientSecretSet: true },
            ] } });
            if (url === '/auth/setup-status') return json({ serverUrl: 'https://flow.example' });
            if (url === '/auth/providers/microsoft' && opts?.method === 'PUT') return json({ message: 'Saved!' });
            return json({}, false);
        });
        const user = userEvent.setup();
        renderWithClient(<SSOConfigPanel />);
        await user.click(await screen.findByRole('button', { name: /Microsoft/ }));
        expect(await screen.findByDisplayValue('Subsidiary')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: /Remove/ }));
        await user.click(screen.getByRole('button', { name: 'admin.sso_save' }));
        await waitFor(() => expect(screen.getByText('Saved!')).toBeTruthy());
        expect(putBody().connections).toEqual([]);
    });
});

describe('Microsoft setup steps: the delegated permissions', () => {
    const listed = () => {
        const step = screen.getByTestId('ms-graph-permissions');
        return [...step.querySelectorAll('code')].map((c) => ({
            name: c.textContent,
            adminConsent: (c.nextElementSibling?.textContent ?? '').includes('teams_setup.ui.needs_admin_consent'),
        }));
    };

    it('without the requirements answer lists every scope the connect flow asks for, the shared-mailbox ones included', async () => {
        const user = userEvent.setup();
        renderWithClient(<SSOConfigPanel />);
        await user.click(await screen.findByRole('button', { name: /Microsoft/ }));
        const names = listed().map((s) => s.name);
        // The /.default admin consent link only approves what the registration lists.
        for (const scope of ['Mail.ReadWrite', 'Mail.Read.Shared', 'Mail.Send.Shared', 'Mail.ReadWrite.Shared', 'OnlineMeetingArtifact.Read.All', 'OnlineMeetingRecording.Read.All', 'User.Read', 'offline_access']) {
            expect(names).toContain(scope);
        }
        expect(names).toEqual(CONNECT_SCOPES_FALLBACK.map((s) => s.name));
        expect(listed().filter((s) => s.adminConsent).map((s) => s.name)).toEqual(['OnlineMeetingTranscript.Read.All', 'OnlineMeetingRecording.Read.All']);
    });

    it('with the requirements answer lists every delegated row from it, requested ones included', async () => {
        const delegated = [
            { name: 'User.Read', kind: 'delegated', option: 'A', role: 'requested', adminConsent: false, purpose: 'sign_in' },
            { name: 'Mail.ReadWrite.Shared', kind: 'delegated', option: 'A', role: 'requested', adminConsent: false, purpose: 'shared_mailbox' },
            { name: 'OnlineMeetingRecording.Read.All', kind: 'delegated', option: 'A', role: 'required', adminConsent: true, purpose: 'recordings' },
        ];
        fetchMock.mockImplementation(async (url: string) => {
            if (url === '/auth/providers') return json(PROVIDERS);
            if (url === '/auth/setup-status') return json({ serverUrl: 'https://flow.example' });
            if (url === '/api/teams-setup/requirements') {
                return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ tenantMode: 'common', redirectUris: { signIn: '', connect: '' }, delegated, application: [] }) } as unknown as Response;
            }
            return json({}, false);
        });
        const user = userEvent.setup();
        renderWithClient(<SSOConfigPanel />);
        await user.click(await screen.findByRole('button', { name: /Microsoft/ }));
        await waitFor(() => expect(listed().map((s) => s.name)).toEqual(['User.Read', 'Mail.ReadWrite.Shared', 'OnlineMeetingRecording.Read.All']));
        expect(listed().filter((s) => s.adminConsent).map((s) => s.name)).toEqual(['OnlineMeetingRecording.Read.All']);
    });
});

describe('button logo checks', () => {
    it('accepts a small image and names what is wrong otherwise', () => {
        expect(logoFileProblem({ type: 'image/png', size: 1024 })).toBeNull();
        expect(logoFileProblem({ type: 'image/svg+xml', size: MAX_LOGO_BYTES })).toBeNull();
        expect(logoFileProblem({ type: 'image/png', size: MAX_LOGO_BYTES + 1 })).toBe('size');
        expect(logoFileProblem({ type: 'text/html', size: 10 })).toBe('type');
    });
});

describe('tenant id checks', () => {
    it('accepts aliases and GUIDs, and treats aliases as multi-tenant', () => {
        expect(isTenantIdValid('')).toBe(true);
        expect(isTenantIdValid(' Organizations ')).toBe(true);
        expect(isTenantIdValid('12345678-1234-1234-1234-123456789abc')).toBe(true);
        expect(isTenantIdValid('contoso')).toBe(false);
        expect(isMultiTenantId('consumers')).toBe(true);
        expect(isMultiTenantId('12345678-1234-1234-1234-123456789abc')).toBe(false);
    });
});
