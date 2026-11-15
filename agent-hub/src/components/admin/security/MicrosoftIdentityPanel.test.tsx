import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MicrosoftIdentityPanel from './MicrosoftIdentityPanel';
import type { UserEvent } from '@testing-library/user-event';
import { makeTestQueryClient, renderWithClient } from '@/test/render';

const { authFetch, t } = vi.hoisted(() => ({ authFetch: vi.fn(), t: (key: string) => key }));
vi.mock('@/utils/helpers', () => ({ API_BASE: '/api', authFetch }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }));
const pending = { id: 'request-1', email: 'existing@example.test', tenant_id: 'tenant', object_id: 'object' };
let requests: { id: string; email: string; tenant_id: string; object_id: string; }[], mutations: { url: string; method: string; body: string }[], conflict: boolean, user: UserEvent;
let accounts: unknown[] | null, organizations: unknown[] | null, binding: Record<string, string>;
const refused = { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) };
beforeEach(() => {
    cleanup(); user = userEvent.setup(); authFetch.mockReset(); requests = [pending]; mutations = []; conflict = false;
    // The lists refuse by default: the panel then asks for typed ids, as before the pickers.
    accounts = null; organizations = null; binding = { syncOrganizationId: 'org-B', syncTenantId: 'tenant-B' };
    authFetch.mockImplementation(async (url: string, options) => {
        if (options?.method && options.method !== 'GET') {
            mutations.push({ url, ...options });
            if (conflict) return { ok: false, json: async () => ({ error: 'sso_link_conflict' }) };
            requests = [];
            return { ok: true, json: async () => ({ ok: true }) };
        }
        if (url.includes('/auth/users')) return accounts ? { ok: true, json: async () => accounts } : refused;
        if (url.includes('/auth/organizations')) return organizations ? { ok: true, json: async () => organizations } : refused;
        return { ok: true, json: async () => url.endsWith('link-requests') ? requests : binding };
    });
});
describe('Microsoft identity administration', () => {
    it('links the reviewed request to an explicit local account and refreshes only after success', async () => {
        renderWithClient(<MicrosoftIdentityPanel />);
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
        renderWithClient(<MicrosoftIdentityPanel />);
        await user.type(await screen.findByLabelText('azure.identity_local_user'), 'local');
        await user.click(screen.getByRole('button', { name: 'azure.identity_confirm' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('sso_link_conflict');
        expect(screen.getByText(/existing@example.test/)).toBeInTheDocument();
    });
    it('requires confirmation to disconnect and resets it when the account changes', async () => {
        renderWithClient(<MicrosoftIdentityPanel />);
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
        renderWithClient(<MicrosoftIdentityPanel />);
        const organization = await screen.findByLabelText('azure.sync_target_organization');
        await waitFor(() => expect(organization).toHaveValue('org-B'));
        await user.clear(organization); await user.type(organization, 'confirmed-org');
        await user.click(screen.getByRole('button', { name: 'azure.sync_confirm_binding' }));
        await waitFor(() => expect(JSON.parse(mutations[0].body)).toEqual({ syncOrganizationId: 'confirmed-org', syncTenantId: 'tenant-B' }));
    });
    it('picks the account to link from the server\'s accounts when they can be read', async () => {
        accounts = [{ id: 'u-2', displayName: 'Bea Visser', email: 'bea@example.test' }, { id: 'u-1', displayName: 'Ann de Wit', email: 'ann@example.test' }];
        renderWithClient(<MicrosoftIdentityPanel />);
        const picker = await screen.findByLabelText('admin_people.ms_link_account');
        await user.selectOptions(picker, 'u-1');
        await user.click(screen.getByRole('button', { name: 'azure.identity_confirm' }));
        await waitFor(() => expect(mutations[0].url).toBe('/api/auth/microsoft/users/u-1/identity'));
    });
    it('picks the organisation of the binding from the organisation list', async () => {
        organizations = [{ id: 'org-B', name: 'Org B' }, { id: 'org-C', name: 'Org C' }];
        renderWithClient(<MicrosoftIdentityPanel />);
        const picker = await screen.findByLabelText('admin_people.ms_sync_organisation');
        await waitFor(() => expect(picker).toHaveValue('org-B'));
        await user.selectOptions(picker, 'org-C');
        await user.click(screen.getByRole('button', { name: 'azure.sync_confirm_binding' }));
        await waitFor(() => expect(JSON.parse(mutations[0].body)).toEqual({ syncOrganizationId: 'org-C', syncTenantId: 'tenant-B' }));
    });
    it('fills an empty binding with the sign-in tenant', async () => {
        binding = {};
        const tenant = '11111111-2222-3333-4444-555555555555';
        renderWithClient(<MicrosoftIdentityPanel ssoTenantId={tenant} />);
        await waitFor(() => expect(screen.getByLabelText('azure.sync_target_tenant')).toHaveValue(tenant));
        expect(screen.getByText('admin_people.ms_tenant_from_sso')).toBeInTheDocument();
    });
    it('fills the binding form again when the panel opens a second time on the cached answer', async () => {
        binding = {};
        const tenant = '11111111-2222-3333-4444-555555555555';
        const client = makeTestQueryClient();
        const panel = <QueryClientProvider client={client}><MicrosoftIdentityPanel ssoTenantId={tenant} /></QueryClientProvider>;
        const first = render(panel);
        await waitFor(() => expect(screen.getByLabelText('azure.sync_target_tenant')).toHaveValue(tenant));
        first.unmount();
        render(panel);
        await waitFor(() => expect(screen.getByLabelText('azure.sync_target_tenant')).toHaveValue(tenant));
    });
});
