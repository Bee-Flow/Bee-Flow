// "Shared with you" on the home: hidden when nothing is shared, a line per item with whose it is and what the reader
// may do, and the item opened read only. The network is the seam (a recording fetch), no module is mocked.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import CoworkSharedWithMe from './CoworkSharedWithMe';

afterEach(() => { vi.unstubAllGlobals(); });

const ITEM = { id: 's1', ownerId: 'ann', ownerName: 'Ann', title: 'Supplier radar', role: 'approver', lastStatus: 'success', lastRunAt: null, isActive: true };
const VIEW = { role: 'approver', item: { id: 's1', title: 'Supplier radar', prompt: 'Read the supplier mail every morning.', repeatInterval: 'daily', nextRunAt: null, lastStatus: 'success', isActive: true, triggerKind: 'schedule' }, runs: [{ id: 'r1', status: 'success', startedAt: null, result: 'Two orders are late.', durationMs: 900 }] };

describe('CoworkSharedWithMe', () => {
    it('shows nothing when nothing is shared', async () => {
        const calls = stubRecordingFetch(() => jsonResponse({ items: [] }));
        const { container } = renderWithClient(<CoworkSharedWithMe />);
        await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(container).toBeEmptyDOMElement();
    });

    it('lists what colleagues shared and opens one read only', async () => {
        stubRecordingFetch(({ url }) => jsonResponse(url.endsWith('/shared') ? { items: [ITEM] } : VIEW));
        renderWithClient(<CoworkSharedWithMe />);
        const line = await screen.findByRole('button', { name: /Supplier radar/ });
        expect(line).toHaveTextContent("Ann's, you decide its questions");
        await userEvent.setup().click(line);
        expect(await screen.findByText('Read the supplier mail every morning.')).toBeInTheDocument();
        expect(screen.getByText(/Two orders are late/)).toBeInTheDocument();
        expect(screen.queryByRole('textbox')).toBeNull();
    });
});
