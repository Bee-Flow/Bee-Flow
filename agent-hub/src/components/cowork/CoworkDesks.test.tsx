// "Desks" on the Cowork home: nothing while the reader is on no desk; a desk opens to its coworks in order, and only
// the reader's own cowork opens. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkDesks from './CoworkDesks';

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

const VIEW = {
    desk: { id: 'd1', name: 'Invoices', isOwner: false, ownerName: 'Ann' },
    members: [
        { scheduleId: 'radar', title: 'Supplier radar', ownerName: 'Ann', mine: false, accepted: true, after: null, lastStatus: 'success', lastRunAt: null, deskRole: null },
        { scheduleId: 'w1', title: 'Invoice intake', ownerName: 'Bob', mine: true, accepted: true, after: 'radar', lastStatus: null, lastRunAt: null, deskRole: null },
    ],
    roles: [],
    colleagues: [],
};

describe('CoworkDesks', () => {
    it('says nothing while the reader is on no desk', async () => {
        calls = stubRecordingFetch(() => jsonResponse({ desks: [] }));
        renderWithClient(<CoworkDesks onOpen={() => {}} />);
        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/cowork/desks'))).toBe(true));
        expect(screen.queryByTestId('cowork-desks')).toBeNull();
    });

    it('opens a desk to its coworks in order; only my own cowork opens', async () => {
        calls = stubRecordingFetch(({ url }) => (url.endsWith('/api/cowork/desks') ? jsonResponse({ desks: [{ id: 'd1', name: 'Invoices', isOwner: false }] }) : jsonResponse(VIEW)));
        const onOpen = vi.fn();
        renderWithClient(<CoworkDesks onOpen={onOpen} />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Invoices' }));
        expect(await screen.findAllByTestId('cowork-desk-member')).toHaveLength(2);
        expect(screen.queryByRole('button', { name: 'Supplier radar' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Invoice intake' }));
        expect(onOpen).toHaveBeenCalledWith('w1');
    });
});
