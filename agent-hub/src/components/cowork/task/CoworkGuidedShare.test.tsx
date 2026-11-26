import {screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, expect, it, vi} from 'vitest';
import {renderWithClient} from '@/test/render';
import {jsonResponse, stubRecordingFetch} from '@/test/recordingFetch';
import {useTranslation} from '@/hooks/useTranslation';
import {openTask} from './taskWorld.testkit';
import {namedColleague} from './coworkColleagueSelection';
import type {Share} from '@/api/coworkShares';
import CoworkTaskPeople, {type PeopleRowId} from './CoworkTaskPeople';

afterEach(() => vi.unstubAllGlobals());

function open(request: string, existing: Share[] = [], row: PeopleRowId = 'share', concurrent?: Share[]) {
    const onTeamwork = vi.fn();
    const calls = stubRecordingFetch(({url, method, body}) => {
        if (url.endsWith('/colleagues')) return jsonResponse({colleagues: [{id: 'n', name: 'Noor'}, {id: 's', name: 'Sam'}]});
        if (url.endsWith('/shares') && method === 'PUT') {
            if (concurrent) {
                existing = concurrent;
                concurrent = undefined;
                return jsonResponse({error:'Access changed. Review again.'},409);
            }
            return jsonResponse(body);
        }
        return jsonResponse({shares: existing});
    });
    function Form() {
        const {t} = useTranslation();
        return <CoworkTaskPeople t={t} coworkId="task" title="Digest" focused open={row} onTeamwork={onTeamwork} request={request} onOpen={vi.fn()} onGone={vi.fn()} />;
    }
    renderWithClient(<Form/>);
    return {user: userEvent.setup(), onTeamwork, calls, writes: () => calls.filter(c => c.method === 'PUT')};
}

it('prefills the named colleague and requested role, saving only after confirmation', async () => {
    const {user, writes} = open('Deel deze taak met Noor als goedkeurder', [{userId:'s', role:'viewer'}]);
    expect(await screen.findByRole('combobox', {name:'Colleague'})).toHaveValue('n');
    expect(screen.queryByText('Give this task away')).toBeNull();
    const role = screen.getByRole('combobox', {name:'What Noor can do'});
    expect(role).toHaveValue('approver');
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole('button', {name:'Confirm access'}));
    await waitFor(() => expect(writes()[0]?.body).toMatchObject({shares:[{userId:'s', role:'viewer'}, {userId:'n', role:'approver'}]}));
});

it('requires a choice when the request names no colleague, and never changes an existing grant on selection', async () => {
    const {user, writes} = open('Share this task', [{userId:'n',role:'viewer'}]);
    const who = await screen.findByRole('combobox', {name:'Colleague'});
    expect(who).toHaveValue('');
    await user.selectOptions(who,'n');
    await user.selectOptions(screen.getByRole('combobox',{name:'What Noor can do'}),'approver');
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole('button',{name:'Confirm access'}));
    await waitFor(() => expect(writes()[0]?.body).toMatchObject({shares:[{userId:'n',role:'approver'}]}));
});

it('lets the owner confirm a named revocation without stepping through permissions again', async () => {
    const {user, writes} = open('Stop sharing with Noor', [{userId:'n',role:'approver'}, {userId:'s',role:'viewer'}]);
    expect(await screen.findByRole('combobox', {name:'What Noor can do'})).toHaveValue('remove');
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole('button', {name:'Remove access'}));
    await waitFor(() => expect(writes()[0]?.body).toMatchObject({shares:[{userId:'s',role:'viewer'}]}));
});

it('prepares a named ownership handover with the consequence and one approval', async () => {
    const {user, calls} = open('Geef deze taak aan Sam', [], 'give');
    expect(await screen.findByRole('combobox', {name:'New owner'})).toHaveValue('s');
    expect(screen.getByText(/Sam gets a paused copy/)).toBeVisible();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await user.click(screen.getByRole('button', {name:'Give it away'}));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({toUserId:'s'}));
});

it('continues a result handoff without a desk into a proposal from the same request', async () => {
    const request = 'Send the results to Noor’s task';
    const {user, onTeamwork, calls} = open(request, [], 'pass');
    await user.click(await screen.findByRole('button', {name:'Propose a setup'}));
    expect(onTeamwork).toHaveBeenCalledWith('setup',request);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
});


it('opens the named sharing form from the task conversation and preserves the approval boundary', async () => {
    const {user, sent} = openTask({colleagues: [{id:'s', name:'Sam'}], conversation: () => ({
        action: 'share', answer: 'Please check access for Sam.', instruction: '',
    })});
    await user.type(await screen.findByRole('textbox', {name:'Ask Bee…'}), 'Share this task with Sam{Enter}');
    expect(await screen.findByRole('combobox', {name:'Colleague'})).toHaveValue('s');
    expect(screen.queryByText('Give this task away')).toBeNull();
    expect(sent('PUT', '/api/cowork/w1/shares')).toBeUndefined();
    await user.click(screen.getByRole('button', {name:'Confirm access'}));
    await waitFor(() => expect(sent('PUT','/api/cowork/w1/shares')?.body).toMatchObject({shares:[{userId:'s',role:'viewer'}]}));
});

it('prefills a unique first name after a recipient cue and asks when it is ambiguous', () => {
    const list = [{id:'n', name:'Noor Peters'}, {id:'s',name:'Sam Jansen'}];
    expect(namedColleague(list,'Deel het met Noor')).toBe('n');
    expect(namedColleague([...list, {id:'n2',name:'Noor Bakker'}],'Deel het met Noor')).toBe('');
});

it('does not offer to add a colleague whose access was already removed', async () => {
    const {writes} = open('Stop sharing with Noor');
    expect(await screen.findByText('Noor already has no access to this task.')).toBeVisible();
    expect(screen.queryByRole('button', {name:'Confirm access'})).toBeNull();
    expect(writes()).toHaveLength(0);
});

it('describes and confirms replacing the current approver in one atomic update', async () => {
    const existing = [{userId:'s', role:'approver' as const}];
    const {writes, user} = open('Share with Noor as approver', existing);
    expect(await screen.findByText('After confirmation, Noor will answer task questions. Sam will keep view access.')).toBeVisible();
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole('button', {name:'Confirm access'}));
    await waitFor(() => expect(writes()[0]?.body).toEqual({expected: existing, shares:[{userId:'s',role:'viewer'},{userId:'n',role:'approver'}]}));
});

it('discards an unconfirmed edit on Back and can handle the same spoken request again', async () => {
    const {user, all} = openTask({colleagues:[{id:'s',name:'Sam'}], conversation: () => ({action:'share', answer:'Review access.', instruction:''})});
    const ask = async () => user.type(await screen.findByRole('textbox', {name:'Ask Bee…'}), 'Share with Sam{Enter}');
    await ask();
    await user.selectOptions(await screen.findByRole('combobox',{name:'What Sam can do'}),'approver');
    await user.click(screen.getByRole('button',{name:'Back to the orb'}));
    expect(all('PUT','/api/cowork/w1/shares')).toHaveLength(0);
    await ask();
    expect(await screen.findByRole('combobox',{name:'What Sam can do'})).toHaveValue('viewer');
});

it('requires a fresh confirmation after someone modifies access in another session', async () => {
    const other = [{userId:'s',role:'approver' as const}];
    const {user, writes} = open('Share with Noor as approver', [], 'share', other);
    await user.click(await screen.findByRole('button',{name:'Confirm access'}));
    expect(await screen.findByText('After confirmation, Noor will answer task questions. Sam will keep view access.')).toBeVisible();
    expect(writes()).toHaveLength(1);
    await user.click(screen.getByRole('button',{name:'Confirm access'}));
    await waitFor(() => expect(writes()[1]?.body).toEqual({expected:other, shares:[{userId:'s',role:'viewer'},{userId:'n',role:'approver'}]}));
});
