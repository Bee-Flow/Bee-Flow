import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MicrosoftIdentityPanel from './MicrosoftIdentityPanel';

const { authFetch, t } = vi.hoisted(() => ({ authFetch: vi.fn(), t: (key) => key }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '/api', authFetch }));
vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }));
const pending = { id: 'request-1', email: 'existing@example.test', tenant_id: 'tenant', object_id: 'object' };
let requests, mutations, conflict, user;
beforeEach(() => {
    cleanup(); user = userEvent.setup(); authFetch.mockReset(); requests = [pending]; mutations = []; conflict = false;
    authFetch.mockImplementation(async (url, options) => {
        if (options?.method) {
            mutations.push({ url, ...options });
            if (conflict) return { ok: false, json: async () => ({ error: 'sso_link_conflict' }) };
            requests = [];
            return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => url.endsWith('link-requests') ? requests : { syncOrganizationId: 'org-B', syncTenantId: 'tenant-B' } };
    });
});
describe('Microsoft identity administration', () => {
    it('links the reviewed request to an explicit local account and refreshes only after success', async () => {
        render(<MicrosoftIdentityPanel />);
        const localUser = await screen.findByLabelText('azure.identity_local_user');
        expect(screen.getByRole('button', { name: 'azure.identity_confirm' })).toBeDisabled();
        await user.type(localUser, 'local/user');
        await user.click(screen.getByRole('button', { name: 'azure.identity_confirm' }));
        await waitFor(() => expect(screen.queryByText(/existing@example.test/)).not.toBeInTheDocument());
        expect(mutations[0].url).toBe('/api/auth/microsoft/users/local%2Fuser/identity');
        expect(JSON.parse(mutations[0].body)).toEqual({ requestId: 'request-1' });
    });
    it('keeps a conflicting request visible and displays the server rejection', async () => {
        conflict = true;
        render(<MicrosoftIdentityPanel />);
        await user.type(await screen.findByLabelText('azure.identity_local_user'), 'local');
        await user.click(screen.getByRole('button', { name: 'azure.identity_confirm' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('sso_link_conflict');
        expect(screen.getByText(/existing@example.test/)).toBeInTheDocument();
    });
    it('requires confirmation to disconnect and resets it when the account changes', async () => {
        render(<MicrosoftIdentityPanel />);
        await screen.findByLabelText('azure.identity_local_user');
        const account = screen.getByLabelText('azure.identity_disconnect_user');
        const button = screen.getByRole('button', { name: 'azure.identity_disconnect' });
        await user.type(account, 'first');
        expect(button).toBeDisabled();
        await user.click(screen.getByRole('checkbox'));
        await user.clear(account); await user.type(account, 'second');
        expect(button).toBeDisabled();
        await user.click(screen.getByRole('checkbox')); await user.click(button);
        await waitFor(() => expect(mutations[0]).toMatchObject({ url: '/api/auth/microsoft/users/second/identity', method: 'DELETE' }));
    });
    it('saves the explicitly selected directory binding', async () => {
        render(<MicrosoftIdentityPanel />);
        const organization = await screen.findByLabelText('azure.sync_target_organization');
        await waitFor(() => expect(organization).toHaveValue('org-B'));
        await user.clear(organization); await user.type(organization, 'confirmed-org');
        await user.click(screen.getByRole('button', { name: 'azure.sync_confirm_binding' }));
        await waitFor(() => expect(JSON.parse(mutations[0].body)).toEqual({ syncOrganizationId: 'confirmed-org', syncTenantId: 'tenant-B' }));
    });
});
