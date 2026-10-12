// Settings → Connections: the page that holds a member's own credentials.
// Pinned: the page names itself; its groups follow the integration catalogue
// (CATEGORY_ORDER) with every integration under its catalogue category; a
// group without rows draws nothing; the organisation's n8n set-up is not part
// of this personal page; a row says whether it is open; and the named-
// connection form offers only the providers the page lists.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBackend } from '@/test/mcpLibraryKit';
import { withQueryClient } from '@/test/queryWrapper';
import IntegrationsSection from './IntegrationsSection';

const { fetchMock, ent } = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    ent: { current: { effective: { integration: [] as string[] }, loading: false, error: null } },
}));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));
vi.mock('../../components/licensing/EntitlementsContext', () => ({ useEntitlements: () => ent.current }));

const MCP_CREDENTIALS = '/ai/mcp-servers/user-credentials';

let api: ReturnType<typeof fakeBackend>;
beforeEach(() => {
    api = fakeBackend(fetchMock);
    api.on('GET', '/api/integrations/connections', { body: { connections: [] } });
    api.on('GET', '/api/integrations/connections/grants', { body: { grants: [] } });
    api.on('GET', MCP_CREDENTIALS, { body: { servers: [] } });
});

function entitle(...ids: string[]) {
    ent.current = { effective: { integration: ids }, loading: false, error: null };
}

// An organisation that restricts its integrations to a list without Nextcloud,
// so the Nextcloud group only shows when a case asks for it.
const NO_NEXTCLOUD = { enabledIntegrations: [] as string[] };

function renderPage(user: object = NO_NEXTCLOUD) {
    return render(withQueryClient(<IntegrationsSection statuses={{}} onSaved={vi.fn()} user={user} />));
}

/** Group headings in document order (the small uppercase labels). */
const groupLabels = () => Array.from(document.querySelectorAll('p.uppercase')).map(p => p.textContent);

describe('IntegrationsSection (Settings → Connections)', () => {
    it('names the page with a heading of its own', async () => {
        entitle();
        renderPage();
        expect(screen.getByRole('heading', { level: 2, name: 'Connections' })).toBeInTheDocument();
        await screen.findByText('Add a connection');
    });

    it('orders the groups like the integration catalogue and files YouTrack under Developer', async () => {
        entitle('gmail', 'youtrack', 'github', 'fireflies', 'withings', 'linkedin');
        renderPage({});
        await screen.findByText('Add a connection');

        expect(groupLabels().slice(1)).toEqual(['Google Workspace', 'Nextcloud', 'Developer', 'Productivity', 'Health', 'Social']);
        const developer = screen.getByText('Developer').parentElement as HTMLElement;
        expect(within(developer).getByText('YouTrack')).toBeInTheDocument();
        expect(within(developer).getByText('GitHub')).toBeInTheDocument();
        const productivity = screen.getByText('Productivity').parentElement as HTMLElement;
        expect(within(productivity).queryByText('YouTrack')).not.toBeInTheDocument();
        expect(within(productivity).queryByText('Nextcloud')).not.toBeInTheDocument();
    });

    it('draws no Developer group when it has no rows', async () => {
        entitle('fireflies', 'mcp:acme');
        renderPage();
        await waitFor(() => expect(api.sent.some(s => s.path === MCP_CREDENTIALS)).toBe(true));
        await screen.findByText('Add a connection');
        expect(screen.queryByText('Developer')).not.toBeInTheDocument();
    });

    it('shows the Developer group for MCP credential rows alone', async () => {
        api.on('GET', MCP_CREDENTIALS, {
            body: { servers: [{ id: 'acme', name: 'Acme MCP', allConfigured: false, toolCount: 3, credentials: [{ key: 'token', label: 'Token' }] }] },
        });
        entitle('mcp:acme');
        renderPage();
        expect(await screen.findByText('Acme MCP')).toBeInTheDocument();
        expect(screen.getByText('Developer')).toBeInTheDocument();
    });

    it('does not carry the organisation n8n block', async () => {
        entitle('n8n', 'fireflies');
        renderPage();
        await screen.findByText('Add a connection');
        expect(screen.queryByText('Organisation Tools')).not.toBeInTheDocument();
        expect(screen.queryByText('n8n')).not.toBeInTheDocument();
    });

    it('a row says whether it is open', async () => {
        entitle('youtrack');
        const user = userEvent.setup();
        renderPage();
        const row = screen.getByRole('button', { name: /YouTrack/ });
        expect(row).toHaveAttribute('aria-expanded', 'false');
        await user.click(row);
        expect(row).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByPlaceholderText('Permanent token')).toBeInTheDocument();
    });

    it('the named-connection form keeps offering every provider, whatever the page lists', async () => {
        // A named credential also serves the Compliance connectors and can be
        // lent to a group that holds an integration the author's groups lack,
        // so the add form is not narrowed to this page's rows.
        entitle('github', 'gamma');
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByText('Add a connection'));
        const options = within(screen.getByRole('combobox', { name: 'Provider' })).getAllByRole('option').map(o => o.textContent);
        expect(options).toContain('YouTrack');
        expect(options).toContain('HTTP API (custom)');
        expect(options.length).toBe(10);
    });

    it('ignores OAuth callback messages from a foreign origin (LinkedIn, Withings)', async () => {
        entitle('withings', 'linkedin');
        api.on('GET', '/api/integrations/withings/status', { body: { configured: true, connected: false } });
        const onSaved = vi.fn();
        render(withQueryClient(<IntegrationsSection statuses={{}} onSaved={onSaved} user={{}} />));
        await screen.findByText('Add a connection');
        const post = (data: object, origin: string) =>
            act(() => { window.dispatchEvent(new MessageEvent('message', { data, origin })); });
        post({ type: 'linkedin-callback', success: true }, 'https://evil.example');
        post({ type: 'withings-callback', success: true }, 'https://evil.example');
        expect(onSaved).not.toHaveBeenCalled();
        post({ type: 'linkedin-callback', success: true }, window.location.origin);
        expect(onSaved).toHaveBeenCalledTimes(1);
    });
});
