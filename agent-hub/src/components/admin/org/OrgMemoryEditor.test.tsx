// The organisation's memory settings: load, save with a validated cap, counts
// without any memory content, and the clear that needs the typed word.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '../../shared/Toast';
import OrgMemoryEditor, { parseMaxPerUser } from './OrgMemoryEditor';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const respond = (status: number, body: unknown) => ({
    ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body,
});
let server: { settings: { enabled: boolean; sensitiveOptInAllowed: boolean; maxPerUser: number }; stats: { activeMemories: number; users: number } };
let puts: unknown[];
let clears: unknown[];
let getStatus: number;
let putExtra: Record<string, unknown>;

beforeEach(() => {
    server = { settings: { enabled: true, sensitiveOptInAllowed: false, maxPerUser: 500 }, stats: { activeMemories: 1234, users: 17 } };
    puts = [];
    clears = [];
    getStatus = 200;
    putExtra = {};
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        const method = init.method || 'GET';
        if (String(url).endsWith('/api/org-memory/org1/clear') && method === 'POST') {
            clears.push(JSON.parse(String(init.body)));
            server = { ...server, stats: { ...server.stats, activeMemories: 0 } };
            return respond(200, { deleted: 1234 });
        }
        if (!String(url).endsWith('/api/org-memory/org1')) return respond(404, { error: 'Not found' });
        if (method === 'PUT') {
            const body = JSON.parse(String(init.body));
            puts.push(body);
            server = { ...server, settings: body };
            return respond(200, { ...server, ...putExtra });
        }
        return getStatus === 200 ? respond(200, server) : respond(getStatus, { error: 'no' });
    });
});

function renderEditor(orgId: string | null = 'org1') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}><OrgMemoryEditor orgId={orgId} /><Toaster /></QueryClientProvider>);
}

describe('parseMaxPerUser', () => {
    it('accepts whole numbers from 50 to 10000 only', () => {
        expect(parseMaxPerUser('50')).toBe(50);
        expect(parseMaxPerUser('10000')).toBe(10000);
        for (const bad of ['49', '10001', '', '12.5', '-100', 'abc', '1e3']) expect(parseMaxPerUser(bad)).toBeNull();
    });
});

describe('OrgMemoryEditor', () => {
    it('renders nothing without an organisation, and asks nothing', () => {
        const { container } = renderEditor(null);
        expect(container).toBeEmptyDOMElement();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a failed load says so instead of showing defaults', async () => {
        getStatus = 503;
        renderEditor();
        expect(await screen.findByText('Could not load the memory settings.')).toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('shows counts and no memory content', async () => {
        renderEditor();
        expect(await screen.findByTestId('org-memory-stats')).toHaveTextContent('Active memories: 1234. People with memories: 17.');
        expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/agents/memory'))).toBe(true);
    });

    it('saves the switches and the cap', async () => {
        const user = userEvent.setup();
        renderEditor();
        const save = await screen.findByRole('button', { name: 'Save' });
        expect(save).toBeDisabled();
        await user.click(screen.getByRole('checkbox', { name: 'Allow members to opt in to sensitive topics' }));
        const cap = screen.getByLabelText('Memories per person');
        await user.clear(cap);
        await user.type(cap, '2000');
        await user.click(save);
        await waitFor(() => expect(puts).toEqual([{ enabled: true, sensitiveOptInAllowed: true, maxPerUser: 2000 }]));
    });

    it('an out-of-range cap shows an error and cannot be saved', async () => {
        const user = userEvent.setup();
        renderEditor();
        await user.click(await screen.findByRole('checkbox', { name: 'Memory enabled for this organisation' }));
        const cap = screen.getByLabelText('Memories per person');
        await user.clear(cap);
        await user.type(cap, '20');
        expect(screen.getByText('Enter a whole number between 50 and 10000.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        await user.clear(cap);
        await user.type(cap, '20000');
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        expect(puts).toEqual([]);
    });

    it('clearing needs the typed word; cancelling sends nothing', async () => {
        const user = userEvent.setup();
        renderEditor();
        await user.click(await screen.findByTestId('org-memory-clear'));
        const confirm = screen.getByTestId('org-memory-clear-confirm');
        expect(confirm).toBeDisabled();
        await user.type(screen.getByLabelText('Type DELETE to confirm'), 'delete');
        expect(confirm).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(clears).toEqual([]);

        await user.click(screen.getByTestId('org-memory-clear'));
        await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
        expect(screen.getByTestId('org-memory-clear-confirm')).toBeEnabled();
        await user.click(screen.getByTestId('org-memory-clear-confirm'));
        await waitFor(() => expect(clears).toEqual([{ confirm: 'DELETE' }]));
        await waitFor(() => expect(screen.queryByTestId('org-memory-clear-confirm')).not.toBeInTheDocument());
    });
});

describe('OrgMemoryEditor: sensitive topics', () => {
    it('refreshes the counts from the save and reports how many sensitive memories went', async () => {
        server.settings.sensitiveOptInAllowed = true;
        const user = userEvent.setup();
        renderEditor();
        await user.click(await screen.findByRole('checkbox', { name: 'Allow members to opt in to sensitive topics' }));
        putExtra = { stats: { activeMemories: 1200, users: 17 }, deletedSensitive: 34 };
        await user.click(screen.getByRole('button', { name: 'Save' }));
        // The warning comes first; nothing is sent until it is confirmed.
        expect(await screen.findByText('Stop allowing sensitive topics?')).toBeInTheDocument();
        expect(puts).toEqual([]);
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(puts).toHaveLength(1));
        expect(await screen.findByText('Deleted 34 sensitive memories.')).toBeInTheDocument();
        expect(await screen.findByTestId('org-memory-stats')).toHaveTextContent('Active memories: 1200.');
    });

    it('cancelling the warning sends nothing', async () => {
        server.settings.sensitiveOptInAllowed = true;
        const user = userEvent.setup();
        renderEditor();
        await user.click(await screen.findByRole('checkbox', { name: 'Allow members to opt in to sensitive topics' }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await screen.findByText('Stop allowing sensitive topics?');
        await user.click(screen.getByTestId('confirm-dialog-cancel'));
        expect(puts).toEqual([]);
    });

    it('turning it ON needs no warning', async () => {
        const user = userEvent.setup();
        renderEditor();
        await user.click(await screen.findByRole('checkbox', { name: 'Allow members to opt in to sensitive topics' }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(puts).toHaveLength(1));
        expect(screen.queryByText('Stop allowing sensitive topics?')).not.toBeInTheDocument();
    });
});

