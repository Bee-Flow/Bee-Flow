import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import AppConnectorStatus from './AppConnectorStatus';
import { DataProvider } from '../DataContext';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * 'connector_status' — the card that ends the "is it empty or is it broken?"
 * question.
 *
 * It must read the MEMBERS endpoint, not the owner-only sync-status route, or
 * the people it exists for would see a permission error where the answer
 * should be.
 */

vi.mock('@/utils/helpers', () => ({
    API_BASE: 'https://api.test',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

function node(props = {}) {
    return {
        id: 'cmp_cs01', type: 'connector_status',
        props: { connectorId: 'conn_mail1', title: null, showSync: true, ...props },
        style: {},
    };
}

function renderCard(n = node(), { appId = 'app_1', mode = 'run' } = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }), mode };
    return renderWithClient(
        <RuntimeProvider value={value}>
            <DataProvider appId={appId}>
                <AppConnectorStatus node={n} />
            </DataProvider>
        </RuntimeProvider>,
    );
}

function reply(connector) {
    return {
        ok: true,
        json: async () => ({ connectors: [{ id: 'conn_mail1', kind: 'mailbox', ...connector }] }),
    };
}

beforeEach(() => {
    globalThis.__authFetch = vi.fn(async () => reply({ provider: 'gmail', connected: true, lastRunAt: null, hasError: false, syncable: true }));
});
afterEach(() => { delete globalThis.__authFetch; });

describe('AppConnectorStatus', () => {
    it('asks the members endpoint, not the owner-only one', async () => {
        renderCard();
        await waitFor(() => expect(globalThis.__authFetch).toHaveBeenCalled());
        const url = globalThis.__authFetch.mock.calls[0][0];
        expect(url).toContain('/runtime/connectors/status');
        expect(url).not.toContain('sync-status');
    });

    it('names the account it reads and offers a check', async () => {
        globalThis.__authFetch = vi.fn(async () => reply({
            provider: 'gmail', mode: 'shared', address: 'intake@shop.test',
            connected: true, lastRunAt: new Date(Date.now() - 120000).toISOString(),
            hasError: false, syncable: true,
        }));
        renderCard();
        expect(await screen.findByText(/Reading intake@shop.test/)).toBeInTheDocument();
        expect(screen.getByText(/checked 2 min ago/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Check now/ })).toBeInTheDocument();
    });

    it('says what to do when the mailbox is not connected', async () => {
        globalThis.__authFetch = vi.fn(async () => reply({
            provider: 'gmail', connected: false, lastRunAt: null, hasError: false, syncable: true,
        }));
        const { container } = renderCard();
        expect(await screen.findByText(/Not connected/)).toBeInTheDocument();
        expect(screen.getByText(/Settings → Connections/)).toBeInTheDocument();
        expect(container.querySelector('[data-connected]')).toBeNull();
    });

    it('renders its shape in the editor without calling anything', () => {
        renderCard(node(), { appId: null, mode: 'edit' });
        expect(globalThis.__authFetch).not.toHaveBeenCalled();
        // No live state, so no live button either — but the card is visible.
        // The sample must not claim a provider the app does not use.
        expect(screen.queryByText(/Gmail/)).toBeNull();
        expect(screen.getByText(/Preview: the real account/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Check now/ })).toBeNull();
    });

    it('an Outlook shared mailbox that has synced shows Outlook, its address and the last check', async () => {
        globalThis.__authFetch = vi.fn(async () => reply({
            provider: 'outlook', integrationId: 'outlook', mode: 'shared', address: 'info@shop.test',
            connected: true, lastRunAt: new Date(Date.now() - 3 * 3600000).toISOString(),
            hasError: false, syncable: true,
        }));
        renderCard();
        expect(await screen.findByText(/Reading info@shop.test/)).toBeInTheDocument();
        expect(screen.getByText(/checked 3 h ago/)).toBeInTheDocument();
        expect(screen.getByText(/Outlook/)).toBeInTheDocument();
        expect(screen.queryByText(/Gmail/)).toBeNull();
        expect(screen.queryByText(/not checked yet/)).toBeNull();
    });

    it('a personal Outlook mailbox with only an integrationId still says Outlook, and never synced says so', async () => {
        globalThis.__authFetch = vi.fn(async () => reply({
            provider: null, integrationId: 'outlook', connected: true, lastRunAt: null, hasError: false, syncable: true,
        }));
        renderCard();
        expect(await screen.findByText(/Reading the Outlook account you signed in with/)).toBeInTheDocument();
        expect(screen.getByText(/not checked yet/)).toBeInTheDocument();
    });
});
