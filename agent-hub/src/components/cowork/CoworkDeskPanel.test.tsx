// "Work on this together" in an item's Settings tab: a cowork not on a desk goes on one of mine or on a new one; an
// invitation is accepted or declined; on a desk it shows the coworks in order, starts after a colleague's cowork,
// chooses the role that decides its questions and leaves; the desk's maker sets the roles. The network is the seam (a recording fetch), no module is
// mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkDeskPanel from './CoworkDeskPanel';
import type { DeskView, ItemDesk } from '@/api/coworkDesks';

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

const VIEW: DeskView = {
    desk: { id: 'd1', name: 'Invoices', isOwner: false, ownerName: 'Ann' },
    members: [
        { scheduleId: 'radar', title: 'Supplier radar', ownerName: 'Ann', mine: false, accepted: true, after: null, lastStatus: 'success', lastRunAt: null, deskRole: null, handOff: null, decidesHandOff: false },
        { scheduleId: 'w1', title: 'Invoice intake', ownerName: 'Bob', mine: true, accepted: true, after: 'radar', lastStatus: null, lastRunAt: null, deskRole: null, handOff: 'waiting', decidesHandOff: false },
    ],
    roles: [{ role: 'invoices', holderId: 'cas', standInId: 'dan', awayUntil: null, holderName: 'Cas', standInName: 'Dan', away: false }],
    colleagues: [],
};

function serve(desk: ItemDesk | null, view: DeskView = VIEW) {
    calls = stubRecordingFetch(({ method, url }) => {
        if (method === 'POST' && url.endsWith('/api/cowork/desks')) return jsonResponse({ ...view, desk: { ...view.desk, id: 'new-desk' } }, 201);
        if (method !== 'GET') return jsonResponse(view);
        if (url.endsWith('/api/cowork/w1/desk')) return jsonResponse({ desk });
        if (url.endsWith('/api/cowork/desks')) return jsonResponse({ desks: [{ id: 'd1', name: 'Invoices', isOwner: true }] });
        return jsonResponse(view);
    });
}

describe('CoworkDeskPanel', () => {
    it('puts a cowork on one of my desks, or makes a new desk with it', async () => {
        serve(null);
        renderWithClient(<CoworkDeskPanel coworkId="w1" />);
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('Desk to put it on'), 'd1');
        await user.click(screen.getByRole('button', { name: 'Put it on this desk' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/cowork/desks/d1/members'))).toBe(true));
        expect(calls.find((c) => c.url.endsWith('/desks/d1/members'))?.body).toEqual({ scheduleId: 'w1' });

        await user.type(screen.getByLabelText('Name of a new desk'), 'Payments');
        await user.click(screen.getByRole('button', { name: 'Make a desk with it' }));
        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/cowork/desks/new-desk/members'))).toBe(true));
        expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/cowork/desks'))?.body).toEqual({ name: 'Payments' });
    });

    it('an invitation joins only when its owner accepts, and can be declined', async () => {
        serve({ id: 'd1', name: 'Invoices', accepted: false, deskRole: null, invitedBy: 'Ann' });
        renderWithClient(<CoworkDeskPanel coworkId="w1" />);
        const user = userEvent.setup();
        expect(await screen.findByTestId('cowork-desk-invitation')).toHaveTextContent('Ann invited this cowork to the desk "Invoices"');
        await user.click(screen.getByRole('button', { name: 'Accept' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/desks/d1/members/w1/accept'))).toBe(true));
        await user.click(screen.getByRole('button', { name: 'Decline' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/desks/d1/members/w1'))).toBe(true));
    });

    it('on a desk: the coworks in the order work moves, the role that decides its questions, and leaving', async () => {
        serve({ id: 'd1', name: 'Invoices', accepted: true, deskRole: null, invitedBy: null });
        renderWithClient(<CoworkDeskPanel coworkId="w1" />);
        const user = userEvent.setup();
        const members = await screen.findAllByTestId('cowork-desk-member');
        expect(members.map((m) => m.textContent)).toEqual([expect.stringContaining("Supplier radarAnn's · Finished"), expect.stringContaining('Invoice intakeyours')]);
        expect(screen.queryByTestId('cowork-desk-roles')).toBeNull();
        await user.selectOptions(screen.getByLabelText('Who decides its questions'), 'invoices');
        await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/desks/d1/members/w1'))).toBe(true));
        expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ deskRole: 'invoices' });
        // The hand-off: this cowork starts after a colleague's on the desk, saved as its start.
        await user.selectOptions(screen.getByLabelText('Start it after'), 'radar');
        await user.click(screen.getByRole('button', { name: 'Start it after that one' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/api/cowork/w1/start'))).toBe(true));
        expect(calls.find((c) => c.url.endsWith('/w1/start'))?.body).toEqual({ kind: 'after_cowork', scheduleId: 'radar' });
        await user.click(screen.getByRole('button', { name: 'Take it off the desk' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    });

    it('a cowork that follows a colleague\'s says it waits; the colleague allows it once, and can stop it again', async () => {
        serve({ id: 'd1', name: 'Invoices', accepted: true, deskRole: null, invitedBy: null });
        const { unmount } = renderWithClient(<CoworkDeskPanel coworkId="w1" />);
        expect(await screen.findByTestId('cowork-desk-hand-off')).toHaveTextContent('Receives nothing until Ann allows it to get the result of "Supplier radar".');
        expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
        unmount();

        // As Ann, on her radar: Bob's intake asks for its result.
        const [radar, intake] = VIEW.members;
        const asAnn = (handOff: 'waiting' | 'allowed'): DeskView => ({
            ...VIEW,
            members: [{ ...radar, mine: true, scheduleId: 'w1' }, { ...intake, mine: false, scheduleId: 'bobs', after: 'w1', handOff, decidesHandOff: true }],
        });
        serve({ id: 'd1', name: 'Invoices', accepted: true, deskRole: null, invitedBy: null }, asAnn('waiting'));
        const user = userEvent.setup();
        const view = renderWithClient(<CoworkDeskPanel coworkId="w1" />);
        expect(await screen.findByTestId('cowork-desk-hand-off')).toHaveTextContent('Asks to receive the result of your "Supplier radar". It runs as Bob.');
        await user.click(screen.getByRole('button', { name: 'Allow' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/desks/d1/members/bobs/hand-off'))).toBe(true));
        view.unmount();

        serve({ id: 'd1', name: 'Invoices', accepted: true, deskRole: null, invitedBy: null }, asAnn('allowed'));
        renderWithClient(<CoworkDeskPanel coworkId="w1" />);
        expect(await screen.findByTestId('cowork-desk-hand-off')).toHaveTextContent('Receives the result of your "Supplier radar".');
        await user.click(screen.getByRole('button', { name: 'Stop sending it' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/desks/d1/members/bobs/hand-off'))).toBe(true));
    });

    it('the desk\'s maker sets the roles as one list: holder, stand-in, away until', async () => {
        const colleagues = [{ id: 'cas', name: 'Cas' }, { id: 'dan', name: 'Dan' }];
        serve({ id: 'd1', name: 'Invoices', accepted: true, deskRole: null, invitedBy: null }, { ...VIEW, desk: { ...VIEW.desk, isOwner: true }, colleagues });
        renderWithClient(<CoworkDeskPanel coworkId="w1" />);
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText('Holder of invoices away until'), '2026-12-01');
        await user.click(screen.getByRole('button', { name: 'Add a role' }));
        await user.type(screen.getByLabelText('Name of role 2'), 'payments');
        expect(screen.getByRole('button', { name: 'Save the roles' })).toBeDisabled();
        await user.selectOptions(screen.getByLabelText('Who holds payments'), 'dan');
        await user.click(screen.getByRole('button', { name: 'Save the roles' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/desks/d1/roles'))).toBe(true));
        expect(calls.find((c) => c.url.endsWith('/roles'))?.body).toEqual({
            roles: [
                { role: 'invoices', holderId: 'cas', standInId: 'dan', awayUntil: '2026-12-01T23:59:59.000Z' },
                { role: 'payments', holderId: 'dan', standInId: null, awayUntil: null },
            ],
        });
    });
});
