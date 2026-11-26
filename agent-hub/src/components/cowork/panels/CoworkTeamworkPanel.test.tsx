// Teamwork, a page of Cowork: the desks the reader is on as cards (roles with stand-ins, who an invitation waits for,
// which task sends each result to which), and "Send each result to a colleague's task": a sentence, a proposal changed
// with dropdowns, "Send invitations".
// The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkTeamworkPanel from './CoworkTeamworkPanel';
import { teamworkRequest } from '../coworkTeamworkRequest';
import { panelProps } from './panelProps.testkit';
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
        renderWithClient(<CoworkTeamworkPanel {...panelProps({ kind: 'teamwork' }, { open: (p) => { if (p.kind === 'task') onOpenTask(p.id); } })} />);
        const card = await screen.findByTestId('cowork-team-desk');
        expect(await within(card).findByText('Waiting for Noor to accept. It takes them one click.')).toBeInTheDocument();
        expect(within(card).getByTestId('cowork-team-role-line')).toHaveTextContent('PurchasingNoorstand-in: Ines');
        expect(within(card).getByTestId('cowork-team-flow')).toHaveTextContent('“Collect supplier mails” (you) sends each result to “Answer the suppliers” (Noor).');
        expect(within(card).getByText('Set up by you')).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(within(card).getByRole('button', { name: 'Open “Collect supplier mails”' }));
        expect(onOpenTask).toHaveBeenCalledWith('collect');
        await user.click(within(card).getByRole('button', { name: 'Allow it' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/desks/d1/members/answer/hand-off'))).toBe(true));
    });

    it('turns a sentence into a proposal, lets the person change a role, and sends the invitations', async () => {
        const calls = serve();
        renderWithClient(<CoworkTeamworkPanel {...panelProps({ kind: 'teamwork' })} />);
        const user = userEvent.setup();
        expect(await screen.findByRole('heading', { name: 'Send each result to a colleague’s task' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Propose a setup' })).toBeDisabled();
        await user.type(screen.getByLabelText('Who does what? Say it in one sentence.'), 'When my supplier mails are done, Noor checks the invoices. Questions go to Noor, Ines stands in.');
        await user.click(screen.getByRole('button', { name: 'Propose a setup' }));
        const proposal = await screen.findByTestId('cowork-team-proposal');
        expect(calls.find((c) => c.url.endsWith('/desks/helper/draft'))?.body).toEqual({ text: 'When my supplier mails are done, Noor checks the invoices. Questions go to Noor, Ines stands in.' });

        expect(within(proposal).getByLabelText('Send each result of')).toHaveValue('collect');
        expect(within(proposal).getByLabelText('To this task')).toHaveValue('answer');
        expect(within(proposal).getByText('Noor is asked to accept once.')).toBeInTheDocument();
        expect(within(proposal).getByText('Only the result is sent on, never access to anyone’s apps. Each colleague accepts once. A result goes from one person to another 3 times at most.')).toBeInTheDocument();
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
        renderWithClient(<CoworkTeamworkPanel {...panelProps({ kind: 'teamwork' })} />);
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

it('uses the original orb request and task for the draft and only applies after approval', async () => {
    const calls = serve();
    const message = 'Connect this task to Noor’s invoices in a team desk.';
    renderWithClient(<CoworkTeamworkPanel {...panelProps({kind:'teamwork', request:{mode:'setup', message, itemId:'collect'}})} />);
    const proposal = await screen.findByTestId('cowork-team-proposal');
    expect(calls.filter(c => c.url.endsWith('/helper/draft')).map(c => c.body)).toEqual([{text:message, itemId:'collect'}]);
    expect(calls.some(c => c.url.endsWith('/helper/apply'))).toBe(false);
    await userEvent.setup().click(within(proposal).getByRole('button', {name:'Send invitations'}));
    expect(await screen.findByTestId('cowork-team-sent')).toBeVisible();
    expect(calls.find(c => c.url.endsWith('/helper/apply'))?.body).toMatchObject({itemId:'collect',expectedDeskId:null});
});

it('keeps desk selection in Bee and requires approval before removing the chosen desk', async () => {
    const calls = serve({desks:[{id:'d1',name:'Supplier desk',isOwner:true},{id:'d2',name:'Other desk',isOwner:false}]});
    const {rerender} = renderWithClient(<CoworkTeamworkPanel {...panelProps({kind:'teamwork',request:{mode:'browse',message:'Show my desks'}})} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', {name:'Choose a desk'}), 'd1');
    expect(await screen.findByRole('article', {name:'Supplier desk'})).toBeVisible();
    rerender(<CoworkTeamworkPanel {...panelProps({kind:'teamwork',request:{mode:'remove',message:'Verwijder deze desk'}})} />);
    expect(await screen.findByText('Remove the desk “Supplier desk” and its connections?')).toBeVisible();
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    await user.click(screen.getByRole('button', {name:'Not now'}));
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    rerender(<CoworkTeamworkPanel {...panelProps({kind:'teamwork',request:{mode:'remove',message:'Verwijder Supplier desk'}})} />);
    await user.click(await screen.findByRole('button', {name:'Remove the desk'}));
    expect(calls.filter(c => c.method === 'DELETE' && c.url.endsWith('/desks/d1'))).toHaveLength(1);
});

it('prepares a named empty desk and creates it only after the user confirms', async () => {
    const calls = stubRecordingFetch(({url,method}) => {
        if (url.endsWith('/desks') && method === 'POST') return jsonResponse({desk:{id:'d1'}});
        return jsonResponse({desks:[]});
    });
    renderWithClient(<CoworkTeamworkPanel {...panelProps({kind:'teamwork',request:{mode:'create',message:'Maak een desk genaamd Facturen'}})} />);
    const field = await screen.findByRole('textbox', {name:'Name of a new desk'});
    expect(field).toHaveValue('Facturen');
    expect(calls.filter(c=>c.method === 'POST')).toHaveLength(0);
    await userEvent.setup().click(screen.getByRole('button',{name:'Create desk'}));
    expect(calls.find(c=>c.method === 'POST')?.body).toEqual({name:'Facturen'});
});

it('keeps another owner’s desk roles read-only at the orb', async () => {
    const calls = serve({desks:[{id:'d1',name:'Supplier desk',isOwner:false}]});
    renderWithClient(<CoworkTeamworkPanel {...panelProps({kind:'teamwork',request:{mode:'roles',message:'Edit the Supplier desk roles'}})} />);
    expect(await screen.findByText('Only the desk owner can change its roles.')).toBeVisible();
    expect(screen.queryByRole('button',{name:'Save the roles'})).toBeNull();
    expect(calls.filter(c=>c.method === 'PUT')).toHaveLength(0);
});

it('leaves unrelated desks untouched when the requested desk does not exist', async () => {
    const calls = serve({desks:[{id:'d1',name:'Supplier desk',isOwner:true}]});
    const turn = teamworkRequest('Remove the Finance desk');
    if (!turn) throw new Error('expected a desk request');
    renderWithClient(<CoworkTeamworkPanel {...panelProps(turn)} />);
    expect(await screen.findByRole('combobox', {name:'Choose a desk'})).toHaveValue('');
    expect(screen.queryByRole('button',{name:'Remove the desk'})).toBeNull();
    expect(calls.some(c=>c.method === 'DELETE')).toBe(false);
});

it('asks for the desk before drafting an ambiguous change and never interprets negation as a desk removal', async () => {
    const calls = serve({desks:[{id:'d1',name:'Supplier desk',isOwner:true}]});
    const turn = teamworkRequest('Change the tasks on a desk');
    if (!turn) throw new Error('expected a desk request');
    renderWithClient(<CoworkTeamworkPanel {...panelProps(turn)} />);
    const select = await screen.findByRole('combobox', {name:'Choose a desk'});
    expect(calls.some(c => c.url.endsWith('/helper/draft'))).toBe(false);
    await userEvent.setup().selectOptions(select, 'd1');
    expect(await screen.findByTestId('cowork-team-proposal')).toBeVisible();
    expect(calls.find(c => c.url.endsWith('/helper/draft'))?.body).toMatchObject({itemId:'collect'});
    expect(teamworkRequest('Verwijder de Supplier desk niet')?.request?.mode).toBe('browse');
    expect(teamworkRequest('Remove a step on the desk')?.request?.mode).toBe('browse');
});

it('lets the task owner choose who answers questions without changing the desk’s roles', async () => {
    const calls = serve({desks:[{id:'d1', name:'Supplier desk', isOwner:false}]});
    const request = teamworkRequest('Change the role for my task on Supplier desk', 'collect');
    if (!request) throw new Error('expected a desk request');
    renderWithClient(<CoworkTeamworkPanel {...panelProps(request)} />);
    const choice = await screen.findByRole('combobox',{name:'Who decides its questions'});
    const user = userEvent.setup();
    await user.selectOptions(choice, 'Purchasing');
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
    await user.click(screen.getByRole('button',{name:'Save'}));
    await waitFor(() => expect(calls.find(c => c.method === 'PUT' && c.url.endsWith('/desks/d1/members/collect'))?.body).toEqual({deskRole:'Purchasing'}));
});

it('shows the start attached to a desk invitation before accepting and reports a partial success', async () => {
    const shared = {id:'d1', name:'Supplier desk', isOwner:false};
    const calls = stubRecordingFetch(({url,method}) => {
        if (method === 'POST' && url.endsWith('/accept')) return jsonResponse({plannedStart:{afterTitle:'Gather mails',applied:false,reason:'The first task has moved.'}});
        if (url.endsWith('/cowork/desks')) return jsonResponse({desks:[shared]});
        if (url.endsWith('/cowork/collect/desk')) return jsonResponse({desk:{id:'d1',accepted:false,plannedAfter:{id:'leader',title:'Gather mails',ownerName:'Noor'}}});
        if (url.endsWith('/cowork/desks/d1')) return jsonResponse({...DESK,members:[{...DESK.members[0],accepted:false}]});
        return jsonResponse({schedules:[{id:'collect',title:'Collect supplier mails'}]});
    });
    renderWithClient(<CoworkTeamworkPanel {...panelProps({kind:'teamwork',request:{mode:'join',message:'Accept the Supplier desk invitation',itemId:'collect'}})} />);
    const accept = await screen.findByRole('button',{name:'Accept, and start "Collect supplier mails" after Noor\'s "Gather mails"'});
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await userEvent.setup().click(accept);
    expect(await screen.findByText('Accepted. It could not start after "Gather mails": The first task has moved.')).toBeVisible();
});
