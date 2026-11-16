import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { useSupportThreadsQuery } from '@/api/queries/supportInbox';
import SupportMailboxCard from './SupportMailboxCard';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
const threadReads = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/support/threads')).length;

/** The inbox's ticket list, still mounted beside Settings (the panel keeps it while another view is open). */
function TicketCount() {
    const q = useSupportThreadsQuery<{ id: string }>('status=open');
    return <p>{`${q.data?.threads.length ?? 0} tickets listed`}</p>;
}

beforeEach(() => {
    fetchMock.mockReset();
    let disconnected = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api/support/mailbox/disconnect') && init?.method === 'POST') { disconnected = true; return json({ ok: true }); }
        if (u.includes('/api/support/mailbox')) return json({ mailbox: disconnected ? null : { connected: true, count: 2 } });
        if (u.includes('/api/support/threads')) return json({ threads: disconnected ? [] : [{ id: 't1' }, { id: 't2' }], counts: {} });
        return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('SupportMailboxCard', () => {
    it('re-reads the inbox\'s tickets after a disconnect, so the deleted mailbox tickets leave the list', async () => {
        const user = userEvent.setup();
        renderWithClient(<><TicketCount /><SupportMailboxCard /></>);
        expect(await screen.findByText('2 tickets listed')).toBeInTheDocument();
        const before = threadReads();
        await user.click(await screen.findByRole('button', { name: /Disconnect mailbox/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Disconnect the mailbox from the support inbox?' });
        await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
        await waitFor(() => expect(threadReads()).toBeGreaterThan(before));
        expect(await screen.findByText('0 tickets listed')).toBeInTheDocument();
        expect(await screen.findByText('No mailbox is feeding this inbox.')).toBeInTheDocument();
    });
});
