// The Teamwork helper: words, then the proposal as sentences with dropdowns, then what was done and what waits for whom.
// What the helper could not match is said plainly next to its dropdown; changing a person in a dropdown is what is set
// up. Opened from an item's People settings and from the Cowork home. The network is the seam (a recording fetch), no
// module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkTeamworkHelper from './CoworkTeamworkHelper';
import CoworkDeskPanel from './CoworkDeskPanel';
import CoworkDesks from './CoworkDesks';
import type { DeskProposal, HelperResult } from '@/api/coworkDeskHelper';

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

const CHOICES: DeskProposal['choices'] = {
    coworks: [
        { scheduleId: 'mails', title: 'Answer supplier mails', ownerName: 'Ann', mine: true },
        { scheduleId: 'invoices', title: 'Invoice check', ownerName: 'Ben', mine: false },
    ],
    people: [{ id: 'ann', name: 'Ann', me: true }, { id: 'ben', name: 'Ben', me: false }, { id: 'lena', name: 'Lena', me: false }],
};
const PROPOSAL: DeskProposal = {
    drafted: true, deskId: null, deskName: 'Supplier invoices',
    chain: [
        { scheduleId: 'mails', title: 'Answer supplier mails', ownerName: 'Ann', mine: true, words: 'my supplier mails' },
        { scheduleId: 'invoices', title: 'Invoice check', ownerName: 'Ben', mine: false, words: 'Ben checks the invoices' },
    ],
    roles: [{ role: 'Purchasing', holderId: 'ben', holderName: 'Ben', standInId: 'lena', standInName: 'Lena', holderWords: 'Ben' }],
    unmatched: [], choices: CHOICES,
};
const RESULT: HelperResult = {
    deskId: 'd1',
    done: [{ kind: 'desk_made', title: 'Supplier invoices' }, { kind: 'added', title: 'Answer supplier mails' }, { kind: 'role_set', role: 'Purchasing', holderName: 'Lena', standInName: null }],
    waiting: [{ kind: 'their_start', title: 'Invoice check', afterTitle: 'Answer supplier mails', who: 'Ben', allowedByYou: true, planned: true }],
};

function serve(proposal: DeskProposal = PROPOSAL) {
    calls = stubRecordingFetch(({ method, url }) => {
        if (method === 'POST' && url.endsWith('/desks/helper/draft')) return jsonResponse(proposal);
        if (method === 'POST' && url.endsWith('/desks/helper/apply')) return jsonResponse(RESULT, 201);
        if (url.endsWith('/api/cowork/desks')) return jsonResponse({ desks: [] });
        if (url.endsWith('/desk')) return jsonResponse({ desk: null });
        return jsonResponse({});
    });
}

async function toProposal(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('What should happen, in your words?'), 'When my supplier mails are done, Ben checks the invoices.');
    await user.click(screen.getByRole('button', { name: 'Set it up' }));
    return screen.findByTestId('cowork-teamwork-proposal');
}

describe('CoworkTeamworkHelper', () => {
    it('goes from words to the proposal to what waits for whom, setting up what the person saw', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkTeamworkHelper itemId="mails" onClose={() => {}} />);
        expect(screen.getByLabelText('What should happen, in your words?')).toHaveAttribute('placeholder', expect.stringContaining('Ben checks the invoices'));
        const proposal = await toProposal(user);
        expect(calls.find((c) => c.url.endsWith('/desks/helper/draft'))?.body).toEqual({ text: 'When my supplier mails are done, Ben checks the invoices.', itemId: 'mails' });

        const steps = within(proposal).getAllByTestId('cowork-teamwork-step');
        expect(within(steps[0]).getByLabelText('Step 1')).toHaveValue('mails');
        expect(steps[1]).toHaveTextContent('It starts after step 1. Ben is asked to agree.');
        expect(within(proposal).getByLabelText('Who answers the questions')).toHaveValue('ben');
        expect(within(proposal).getByLabelText('Who stands in')).toHaveValue('lena');
        expect(screen.getByDisplayValue('Supplier invoices')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Set it up' }));
        const result = await screen.findByTestId('cowork-teamwork-result');
        expect(calls.find((c) => c.url.endsWith('/desks/helper/apply'))?.body).toEqual({
            itemId: 'mails',
            draft: { deskName: 'Supplier invoices', chain: ['mails', 'invoices'], roles: [{ role: 'Purchasing', holderId: 'ben', standInId: 'lena' }] },
        });
        expect(result).toHaveTextContent('The desk "Supplier invoices" is made.');
        expect(within(screen.getByTestId('cowork-teamwork-waiting')).getByText(/^Ben has been asked to agree\. Accepting puts "Invoice check" on the desk and starts it after "Answer supplier mails"\./)).toBeInTheDocument();
    });

    it('says plainly what it could not match, and offers the dropdown instead', async () => {
        serve({
            ...PROPOSAL, drafted: true,
            chain: [PROPOSAL.chain[0], { scheduleId: null, title: null, ownerName: null, mine: false, words: 'checks the invoices' }],
            roles: [{ role: 'Purchasing', holderId: null, holderName: null, standInId: null, standInName: null, holderWords: 'Bert' }],
            unmatched: ['checks the invoices', 'Bert'],
        });
        const user = userEvent.setup();
        renderWithClient(<CoworkTeamworkHelper onClose={() => {}} />);
        const proposal = await toProposal(user);
        expect(proposal).toHaveTextContent('I could not find a cowork for "checks the invoices". Choose one:');
        expect(proposal).toHaveTextContent('I could not find "Bert" among your colleagues. Choose who:');
        expect(screen.getByRole('button', { name: 'Set it up' })).toBeDisabled();
        expect(screen.getByTestId('cowork-teamwork-not-ready')).toHaveTextContent('Choose a cowork for every step.');
        await user.selectOptions(screen.getByLabelText('Step 2'), 'invoices');
        await user.selectOptions(screen.getByLabelText('Who answers the questions'), 'ben');
        expect(screen.getByRole('button', { name: 'Set it up' })).toBeEnabled();
    });

    it('changing a person in a dropdown is what is set up, and the result names who must agree', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkTeamworkHelper onClose={() => {}} />);
        await toProposal(user);
        await user.selectOptions(screen.getByLabelText('Who answers the questions'), 'lena');
        // A stand-in is someone other than the holder: choosing Lena as holder leaves no stand-in.
        expect(screen.getByLabelText('Who stands in')).toHaveValue('');
        await user.selectOptions(screen.getByLabelText('Who stands in'), 'ann');
        await user.click(screen.getByRole('button', { name: 'Set it up' }));
        await screen.findByTestId('cowork-teamwork-result');
        expect(calls.find((c) => c.url.endsWith('/desks/helper/apply'))?.body).toMatchObject({ draft: { roles: [{ role: 'Purchasing', holderId: 'lena', standInId: 'ann' }] } });
        expect(screen.getByTestId('cowork-teamwork-result')).toHaveTextContent('Questions go to Purchasing: Lena.');
        expect(screen.getByTestId('cowork-teamwork-waiting')).toHaveTextContent('Ben has been asked to agree.');
    });

    it('refuses four hand-offs between people in a row before anything is sent', async () => {
        const coworks = [
            { scheduleId: 'a1', title: 'A1', ownerName: 'Ann', mine: true }, { scheduleId: 'b1', title: 'B1', ownerName: 'Ben', mine: false },
            { scheduleId: 'a2', title: 'A2', ownerName: 'Ann', mine: true }, { scheduleId: 'b2', title: 'B2', ownerName: 'Ben', mine: false },
            { scheduleId: 'a3', title: 'A3', ownerName: 'Ann', mine: true },
        ];
        serve({ ...PROPOSAL, roles: [], choices: { ...CHOICES, coworks }, chain: coworks.map((c) => ({ ...c, words: '' })) });
        const user = userEvent.setup();
        renderWithClient(<CoworkTeamworkHelper onClose={() => {}} />);
        await toProposal(user);
        expect(screen.getByTestId('cowork-teamwork-not-ready')).toHaveTextContent('At most three hand-offs in a row');
        await user.click(screen.getByRole('button', { name: 'Leave out step 5' }));
        expect(screen.queryByTestId('cowork-teamwork-not-ready')).toBeNull();
    });

    it('is the first way in from an item\'s People settings, with every setting still under All settings', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkDeskPanel coworkId="mails" />);
        await user.click(await screen.findByRole('button', { name: 'Help me set this up' }));
        expect(screen.getByTestId('cowork-teamwork-helper')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'All settings' }));
        expect(await screen.findByLabelText('Name of a new desk')).toBeInTheDocument();
    });

    it('on a desk the person made: "Change with the helper"', async () => {
        const view = { desk: { id: 'd1', name: 'Invoices', isOwner: true, ownerName: 'Ann' }, members: [], roles: [], colleagues: [] };
        calls = stubRecordingFetch(({ url }) => (url.endsWith('/api/cowork/mails/desk')
            ? jsonResponse({ desk: { id: 'd1', name: 'Invoices', accepted: true, deskRole: null, invitedBy: null } })
            : jsonResponse(url.endsWith('/api/cowork/desks') ? { desks: [] } : view)));
        const user = userEvent.setup();
        renderWithClient(<CoworkDeskPanel coworkId="mails" />);
        await user.click(await screen.findByRole('button', { name: 'Change with the helper' }));
        expect(screen.getByTestId('cowork-teamwork-helper')).toBeInTheDocument();
    });

    it('is a quiet "Set up teamwork" on the Cowork home while the person is on no desk', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkDesks onOpen={() => {}} />);
        await user.click(await screen.findByRole('button', { name: 'Set up teamwork' }));
        expect(screen.getByTestId('cowork-teamwork-helper')).toBeInTheDocument();
        await toProposal(user);
        await waitFor(() => expect(calls.find((c) => c.url.endsWith('/desks/helper/draft'))?.body).toEqual({ text: 'When my supplier mails are done, Ben checks the invoices.' }));
    });
});
