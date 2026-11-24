// Teamwork in the Cowork sheet: the desks the reader is on as cards (roles with stand-ins, who an invitation waits for,
// how the result flows), and "Help me set this up": a sentence, a proposal changed with dropdowns, "Send invitations".
// The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import { CoworkTeamworkPanel } from './CoworkTeamworkPanel';
import type { DeskView } from '@/api/coworkDesks';
import type { DeskProposal, HelperResult } from '@/api/coworkDeskHelper';

afterEach(() => { vi.unstubAllGlobals(); });

const DESK: DeskView = {
    desk: { id: 'd1', name: 'Supplier desk', isOwner: true, ownerName: 'Sam' },
    members: [
        { scheduleId: 'collect', title: 'Collect supplier mails', ownerName: 'Sam', mine: true, accepted: true, after: null, lastStatus: null, lastRunAt: null, deskRole: null, handOff: null, decidesHandOff: false },
        { scheduleId: 'answer', title: 'Answer the suppliers', ownerName: 'Noor', mine: false, accepted: false, after: 'collect', lastStatus: null, lastRunAt: null, deskRole: null, handOff: 'waiting', decidesHandOff: true },
    ],
    roles: [{ role: 'Purchasing', holderId: 'noor', standInId: 'ines', awayUntil: null, holderName: 'Noor', standInName: 'Ines', away: false }],
    colleagues: [],
};
const CHOICES: DeskProposal['choices'] = {
    coworks: [
        { scheduleId: 'collect', title: 'Collect supplier mails', ownerName: 'Sam', mine: true },
        { scheduleId: 'answer', title: 'Answer the suppliers', ownerName: 'Noor', mine: false },
    ],
    people: [{ id: 'sam', name: 'Sam', me: true }, { id: 'noor', name: 'Noor', me: false }, { id: 'ines', name: 'Ines', me: false }],
};
const PROPOSAL: DeskProposal = {
    drafted: true, deskId: null, deskName: 'Supplier invoices',
    chain: [
        { scheduleId: 'collect', title: 'Collect supplier mails', ownerName: 'Sam', mine: true, words: 'my supplier mails' },
        { scheduleId: 'answer', title: 'Answer the suppliers', ownerName: 'Noor', mine: false, words: 'Noor checks the invoices' },
    ],
    roles: [{ role: 'Purchasing', holderId: 'noor', holderName: 'Noor', standInId: 'ines', standInName: 'Ines', holderWords: 'Noor' }],
    unmatched: [], choices: CHOICES,
};
const RESULT: HelperResult = {
    deskId: 'd2',
    done: [{ kind: 'desk_made', title: 'Supplier invoices' }],
    waiting: [{ kind: 'invited', title: 'Answer the suppliers', who: 'Noor' }],
};

function serve({ desks = [] as Array<{ id: string; name: string; isOwner: boolean }>, proposal = PROPOSAL } = {}): RecordedCall[] {
    return stubRecordingFetch(({ method, url }) => {
        if (method === 'POST' && url.endsWith('/desks/helper/draft')) return jsonResponse(proposal);
        if (method === 'POST' && url.endsWith('/desks/helper/apply')) return jsonResponse(RESULT, 201);
        if (url.endsWith('/api/cowork/desks')) return jsonResponse({ desks });
        if (url.endsWith('/api/cowork/desks/d1')) return jsonResponse(DESK);
        if (method === 'POST' && url.endsWith('/hand-off')) return jsonResponse({});
        return jsonResponse({});
    });
}

describe('CoworkTeamworkPanel', () => {
    it('shows a desk as a card: roles with stand-ins, who an invitation waits for, and where the result flows', async () => {
        const calls = serve({ desks: [{ id: 'd1', name: 'Supplier desk', isOwner: true }] });
        const onOpenTask = vi.fn();
        renderWithClient(<CoworkTeamworkPanel onClose={() => {}} onOpenTask={onOpenTask} />);
        const card = await screen.findByTestId('cowork-team-desk');
        expect(await within(card).findByText('Waiting for Noor to accept. It takes them one click.')).toBeInTheDocument();
        expect(within(card).getByTestId('cowork-team-role-line')).toHaveTextContent('PurchasingNoorstand-in: Ines');
        expect(within(card).getByTestId('cowork-team-flow')).toHaveTextContent('“Collect supplier mails” (you) passes its result to “Answer the suppliers” (Noor).');
        expect(within(card).getByText('Set up by you')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(within(card).getByRole('button', { name: 'Open “Collect supplier mails”' }));
        expect(onOpenTask).toHaveBeenCalledWith('collect');
        await user.click(within(card).getByRole('button', { name: 'Allow it' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/desks/d1/members/answer/hand-off'))).toBe(true));
    });

    it('turns a sentence into a proposal, lets the person change a role, and sends the invitations', async () => {
        const calls = serve();
        renderWithClient(<CoworkTeamworkPanel onClose={() => {}} onOpenTask={() => {}} />);
        const user = userEvent.setup();
        expect(await screen.findByRole('heading', { name: 'Help me set this up' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Propose a setup' })).toBeDisabled();
        await user.type(screen.getByLabelText('Who does what? Say it in one sentence.'), 'When my supplier mails are done, Noor checks the invoices. Questions go to Noor, Ines stands in.');
        await user.click(screen.getByRole('button', { name: 'Propose a setup' }));
        const proposal = await screen.findByTestId('cowork-team-proposal');
        expect(calls.find((c) => c.url.endsWith('/desks/helper/draft'))?.body).toEqual({ text: 'When my supplier mails are done, Noor checks the invoices. Questions go to Noor, Ines stands in.' });

        expect(within(proposal).getByLabelText('Pass the result of')).toHaveValue('collect');
        expect(within(proposal).getByLabelText('To this task')).toHaveValue('answer');
        expect(within(proposal).getByText('Noor is asked to accept once.')).toBeInTheDocument();
        expect(within(proposal).getByText(/Only the result is passed on, never access to anyone’s apps\. Each colleague accepts once\. A chain stops after 3 hand-offs\./)).toBeInTheDocument();
        expect(within(proposal).getByLabelText('Who')).toHaveValue('noor');
        expect(within(proposal).getByLabelText('Stand-in')).toHaveValue('ines');

        // Change who answers, and rename the role: the holder cannot stand in for themselves.
        await user.selectOptions(within(proposal).getByLabelText('Who'), 'ines');
        expect(within(proposal).getByLabelText('Stand-in')).toHaveValue('');
        await user.selectOptions(within(proposal).getByLabelText('Stand-in'), 'noor');
        await user.clear(within(proposal).getByLabelText('Role'));
        await user.type(within(proposal).getByLabelText('Role'), 'Purchasing desk');
        expect(calls.filter((c) => c.url.endsWith('/desks/helper/apply'))).toHaveLength(0);

        await user.click(within(proposal).getByRole('button', { name: 'Send invitations' }));
        const sent = await screen.findByTestId('cowork-team-sent');
        expect(sent).toHaveTextContent('Done. Invitations are sent.');
        expect(sent).toHaveTextContent('Noor has been asked to agree.');
        expect(calls.find((c) => c.url.endsWith('/desks/helper/apply'))?.body).toEqual({
            draft: { deskName: 'Supplier invoices', chain: ['collect', 'answer'], roles: [{ role: 'Purchasing desk', holderId: 'ines', standInId: 'noor' }] },
        });
    });

    it('does not send while a dropdown is empty, and says what is missing', async () => {
        serve({ proposal: { ...PROPOSAL, chain: [PROPOSAL.chain[0], { ...PROPOSAL.chain[1], scheduleId: null, words: 'the finance person' }] } });
        renderWithClient(<CoworkTeamworkPanel onClose={() => {}} onOpenTask={() => {}} />);
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText('Who does what? Say it in one sentence.'), 'Finance checks it');
        await user.click(screen.getByRole('button', { name: 'Propose a setup' }));
        const proposal = await screen.findByTestId('cowork-team-proposal');
        expect(within(proposal).getByText('I could not find a task for “the finance person”. Choose one:')).toBeInTheDocument();
        expect(within(proposal).getByRole('button', { name: 'Send invitations' })).toBeDisabled();
        expect(within(proposal).getByTestId('cowork-team-not-ready')).toHaveTextContent('Choose a task in every dropdown.');
        await user.selectOptions(within(proposal).getByLabelText('To this task'), 'answer');
        expect(within(proposal).getByRole('button', { name: 'Send invitations' })).toBeEnabled();
    });
});
