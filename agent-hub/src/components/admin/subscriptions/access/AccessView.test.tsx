import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessView } from './AccessView';
import { apiJson } from '../hooks/useApi';

vi.mock('../hooks/useApi', () => ({ apiJson: vi.fn() }));
vi.mock('../../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

const apiMock = vi.mocked(apiJson);

beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
        if (path === '/auth/admin/signup-settings') {
            return {
                allowOrgSignups: true, allowConsumerSignups: false, waitlistEnabled: true,
                connectorOnly: false, allowSignupsEnv: true, geoMode: 'allowlist', geoCountries: ['NL'],
                consumerLoginMethods: ['password'],
            };
        }
        if (path === '/auth/admin/waitlist') return [{ id: 'u1', displayName: 'Ada', email: 'ada@example.com' }];
        return {};
    });
});
afterEach(cleanup);

describe('AccessView', () => {
    it('loads the settings, the geo list and the waitlist', async () => {
        render(<AccessView />);
        expect(await screen.findByText('Access Control')).toBeTruthy();
        expect(screen.getByText('Netherlands')).toBeTruthy();
        expect(screen.getByText('Ada')).toBeTruthy();
        expect(screen.getByText('visible on the login page')).toBeTruthy();
    });

    it('saves exactly the stored settings, in order', async () => {
        const user = userEvent.setup();
        render(<AccessView />);
        await user.click(await screen.findByRole('button', { name: /Save changes/ }));
        await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/auth/admin/signup-settings', expect.objectContaining({ method: 'PUT' })));
        const put = apiMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === 'PUT');
        const body = JSON.parse(String((put?.[1] as RequestInit).body));
        expect(Object.keys(body)).toEqual([
            'allowOrgSignups', 'allowConsumerSignups', 'waitlistEnabled', 'emailVerificationEnabled',
            'requireMfaForPasswordAccounts', 'consumerLoginMethods', 'connectorOnly', 'geoMode',
            'geoCountries', 'geoBlockUnknown', 'geoApplyConnector',
        ]);
        expect(body).toMatchObject({ allowConsumerSignups: false, geoMode: 'allowlist', geoCountries: ['NL'], consumerLoginMethods: ['password'] });
    });
});
