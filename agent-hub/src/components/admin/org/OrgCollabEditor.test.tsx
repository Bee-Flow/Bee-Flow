// The organisation's switch for editing together: loading, a load that
// failed (never shown as the default), switching on at once, switching off
// only after a confirm, a refused save, and the operator's server-wide
// switch shown as a locked toggle with its reason.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import OrgCollabEditor from './OrgCollabEditor';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const respond = (status: number, body: unknown) => ({
    ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body,
});
let server: { collabEnabled: boolean; serverDisabled: boolean; configured: boolean };
let puts: unknown[];
let getStatus: number;
let putStatus: number;

beforeEach(() => {
    server = { collabEnabled: true, serverDisabled: false, configured: false };
    puts = [];
    getStatus = 200;
    putStatus = 200;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if (!String(url).endsWith('/api/org-collab/org1')) return respond(404, { error: 'Not found' });
        if ((init.method || 'GET') === 'PUT') {
            const body = JSON.parse(String(init.body));
            puts.push(body);
            if (putStatus !== 200) return respond(putStatus, { error: 'Only an admin of this organisation can switch co-editing on or off.', code: 'not_org_admin' });
            server = { ...server, ...body, configured: true };
            return respond(200, server);
        }
        return getStatus === 200 ? respond(200, server) : respond(getStatus, { error: 'The co-editing setting could not be read.' });
    });
});

function renderEditor(orgId: string | null = 'org1', enabled?: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}><OrgCollabEditor orgId={orgId} enabled={enabled} /></QueryClientProvider>);
}
const toggle = () => screen.findByRole('checkbox', { name: /edit project notebooks and pages together/ });

it('renders nothing without an organisation, and asks nothing', () => {
    const { container } = renderEditor(null);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
});

it('a failed load says so instead of showing the default as saved', async () => {
    getStatus = 503;
    renderEditor();
    expect(await screen.findByText('Could not load this setting.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it('switching on saves at once', async () => {
    server.collabEnabled = false;
    const user = userEvent.setup();
    renderEditor();
    const box = await toggle();
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(puts).toEqual([{ collabEnabled: true }]));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(await toggle()).toBeChecked();
});

it('switching off asks first; cancelling saves nothing, confirming saves false', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(await toggle());
    expect(await screen.findByText('Stop editing together?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(puts).toEqual([]);
    expect(await toggle()).toBeChecked();

    await user.click(await toggle());
    await user.click(await screen.findByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(puts).toEqual([{ collabEnabled: false }]));
    await waitFor(async () => expect(await toggle()).not.toBeChecked());
});

it('a refused save says who may change it and keeps the switch as it was', async () => {
    putStatus = 403;
    server.collabEnabled = false;
    const user = userEvent.setup();
    renderEditor();
    await user.click(await toggle());
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an admin of this organisation can change this.');
    expect(await toggle()).not.toBeChecked();
});

it('switched off by the operator: the toggle is locked and says why', async () => {
    server.serverDisabled = true;
    const user = userEvent.setup();
    renderEditor();
    const box = await toggle();
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(screen.getByTestId('org-collab-server-off')).toHaveTextContent('Switched off for this server by the operator');
    await user.click(box);
    expect(puts).toEqual([]);
});

it('where Projects cannot be used (plan or operator switch), shows nothing and asks nothing', async () => {
    // The setting acts only inside projects: an admin without them is not
    // offered a switch for something nobody in the organisation can use.
    const { container } = renderEditor('org1', false);
    expect(container).toBeEmptyDOMElement();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
});
