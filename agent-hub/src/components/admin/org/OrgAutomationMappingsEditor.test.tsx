// The organisation's switch for updating automation mappings on open (M8b):
// off by default, a load that failed is never shown as the default, switching
// saves at once, and a refused save says who may change it.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import OrgAutomationMappingsEditor from './OrgAutomationMappingsEditor';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const respond = (status: number, body: unknown) => ({
    ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body,
});
let server: { autoUpgradeOnOpen: boolean; configured: boolean };
let puts: unknown[];
let getStatus: number;
let putStatus: number;

beforeEach(() => {
    server = { autoUpgradeOnOpen: false, configured: false };
    puts = [];
    getStatus = 200;
    putStatus = 200;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if (!String(url).endsWith('/api/org-automation-mappings/org1')) return respond(404, { error: 'Not found' });
        if ((init.method || 'GET') === 'PUT') {
            const body = JSON.parse(String(init.body));
            puts.push(body);
            if (putStatus !== 200) return respond(putStatus, { error: 'Only an admin of this organisation can change this setting.', code: 'not_org_admin' });
            server = { ...server, ...body, configured: true };
            return respond(200, server);
        }
        return getStatus === 200 ? respond(200, server) : respond(getStatus, { error: 'The mapping update setting could not be read.' });
    });
});

function renderEditor(orgId: string | null = 'org1') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}><OrgAutomationMappingsEditor orgId={orgId} /></QueryClientProvider>);
}
const toggle = () => screen.findByRole('checkbox', { name: /Update mappings automatically when an automation is opened/ });

it('renders nothing without an organisation, and asks nothing', () => {
    const { container } = renderEditor(null);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
});

it('off by default; switching on saves at once, switching off too', async () => {
    const user = userEvent.setup();
    renderEditor();
    const box = await toggle();
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(puts).toEqual([{ autoUpgradeOnOpen: true }]));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(await toggle()).toBeChecked();
    await user.click(await toggle());
    await waitFor(() => expect(puts).toEqual([{ autoUpgradeOnOpen: true }, { autoUpgradeOnOpen: false }]));
});

it('a failed load says so instead of showing the default as saved', async () => {
    getStatus = 503;
    renderEditor();
    expect(await screen.findByText('Could not load this setting.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it('a refused save says who may change it and keeps the switch as it was', async () => {
    putStatus = 403;
    const user = userEvent.setup();
    renderEditor();
    await user.click(await toggle());
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an admin of this organisation can change this.');
    expect(await toggle()).not.toBeChecked();
});
