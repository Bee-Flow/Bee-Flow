import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ModulesPanel from './index';
import { authFetch } from '@/utils/helpers';
import { asMock } from '@/test/mocks';

const reloadSpy = vi.hoisted(() => vi.fn());

// apiClient (api/client.ts) rides on authFetch — mocking helpers controls the
// whole network layer. Entitlements reload + t() are stubbed for determinism.
vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../licensing/EntitlementsContext', () => ({ useEntitlements: () => ({ reload: reloadSpy }) }));
vi.mock('@/hooks/useTranslation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

const jsonRes = (body: unknown, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
});

const baseModule = {
    id: 'support_studio',
    name: 'Support Studio',
    description: 'Tenant support inbox.',
    category: 'support',
    icon: '📥',
    version: '1.0.0',
    available: true,
    status: 'removed',
    source: 'default',
    importedAt: null,
    importedBy: null,
    requirementsMet: true,
    requirements: [{ id: 'tier', label: 'Enterprise tier', met: true }],
    capabilities: [{ id: 'cap_support', label: 'Support inbox', kind: 'core' }],
};

const postCalls = () => asMock(authFetch).mock.calls.filter(([, init]) => init?.method === 'POST');

const renderPanel = () => {
    // Fresh client per test — no cache bleed, and no React-Query retries so
    // error paths surface immediately (apiClient's own retry skips 4xx).
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ModulesPanel />
        </QueryClientProvider>
    );
};

describe('ModulesPanel', () => {
    beforeEach(() => {
        cleanup();
        asMock(authFetch).mockReset();
        reloadSpy.mockReset();
    });

    it('shows a loading spinner while the module list loads', () => {
        asMock(authFetch).mockImplementation(() => new Promise(() => {}));
        renderPanel();
        expect(screen.getByTestId('modules-loading')).toBeInTheDocument();
    });

    it('shows the load error and retry refetches the list', async () => {
        const user = userEvent.setup();
        asMock(authFetch)
            .mockImplementationOnce(() => jsonRes({ error: 'nope' }, 400))
            .mockImplementation(() => jsonRes({ modules: [baseModule] }));
        renderPanel();
        expect(await screen.findByTestId('modules-error')).toBeInTheDocument();

        await user.click(screen.getByText('modules.retry'));
        expect(await screen.findByText('Support Studio')).toBeInTheDocument();
        expect(screen.queryByTestId('modules-error')).toBeNull();
    });

    it('renders the imported badge for imported modules', async () => {
        asMock(authFetch).mockImplementation(() =>
            jsonRes({ modules: [{ ...baseModule, status: 'imported', importedAt: '2026-07-03T00:00:00Z', importedBy: 'admin' }] }));
        renderPanel();
        expect(await screen.findByText('modules.badge_imported')).toBeInTheDocument();
        expect(screen.queryByText('modules.import')).toBeNull();
    });

    it('disables Import and shows the amber hint when requirements are unmet', async () => {
        const mod = {
            ...baseModule,
            requirementsMet: false,
            requirements: [{ id: 'tier', label: 'Enterprise tier', met: false, detail: 'Requires an enterprise licence' }],
        };
        asMock(authFetch).mockImplementation(() => jsonRes({ modules: [mod] }));
        renderPanel();
        expect(await screen.findByText('modules.requirements_blocked')).toBeInTheDocument();
        expect(screen.getByText('modules.badge_requirements_unmet')).toBeInTheDocument();
        expect(screen.getByText('Requires an enterprise licence')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'modules.import' })).toBeDisabled();
    });

    it('imports a module: POSTs, reloads entitlements, shows the success banner', async () => {
        const user = userEvent.setup();
        asMock(authFetch).mockImplementation((url: string, init = {}) => {
            if (init.method === 'POST' && String(url).endsWith('/api/admin/modules/support_studio/import')) {
                return jsonRes({ ok: true, module: { ...baseModule, status: 'imported' } });
            }
            return jsonRes({ modules: [baseModule] });
        });
        renderPanel();
        await user.click(await screen.findByRole('button', { name: 'modules.import' }));

        await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
        expect(await screen.findByText('modules.import_success')).toBeInTheDocument();
        expect(postCalls()).toHaveLength(1);
        expect(String(postCalls()[0][0])).toContain('/api/admin/modules/support_studio/import');
    });

    it('remove opens the dialog; cancel no-ops; confirm POSTs remove and reloads', async () => {
        const user = userEvent.setup();
        asMock(authFetch).mockImplementation((url: string, init = {}) => {
            if (init.method === 'POST' && String(url).endsWith('/api/admin/modules/support_studio/remove')) {
                return jsonRes({ ok: true, module: { ...baseModule, status: 'removed' } });
            }
            return jsonRes({ modules: [{ ...baseModule, status: 'imported' }] });
        });
        renderPanel();

        await user.click(await screen.findByTitle('modules.remove'));
        expect(screen.getByText('modules.remove_confirm_title')).toBeInTheDocument();

        await user.click(screen.getByText('modules.cancel'));
        expect(screen.queryByText('modules.remove_confirm_title')).toBeNull();
        expect(postCalls()).toHaveLength(0);

        await user.click(screen.getByTitle('modules.remove'));
        await user.click(screen.getByText('modules.remove_confirm_cta'));

        await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
        expect(await screen.findByText('modules.remove_success')).toBeInTheDocument();
        expect(postCalls()).toHaveLength(1);
        expect(String(postCalls()[0][0])).toContain('/api/admin/modules/support_studio/remove');
    });
});
