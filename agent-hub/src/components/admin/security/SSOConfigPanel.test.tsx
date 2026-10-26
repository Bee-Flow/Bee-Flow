import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMultiTenantId, isTenantIdValid } from './sso/MicrosoftSsoTab';
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
    microsoft: { enabled: false, clientId: 'ms-id', clientSecretSet: false, tenantId: 'common' },
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
        const put = fetchMock.mock.calls.find(([url, opts]) => url === '/auth/providers/microsoft' && (opts as RequestInit | undefined)?.method === 'PUT');
        expect(JSON.parse(String((put?.[1] as RequestInit | undefined)?.body))).toEqual({ clientId: 'ms-id', tenantId: 'common', clientSecret: 's3cret' });
        expect((secret as HTMLInputElement).value).toBe('');
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
