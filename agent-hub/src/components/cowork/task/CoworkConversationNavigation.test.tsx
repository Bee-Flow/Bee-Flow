import { screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ITEM, openTask, RUN } from './taskWorld.testkit';

afterEach(() => vi.unstubAllGlobals());

it('retains the delivery question when the user replies with only an address', async () => {
    const address = 'noor@example.org';
    const instruction = 'Send the task result to ' + address;
    const { user, all, sent } = openTask({ conversation: body => {
        const {message} = body as {message: string};
        return message === address ? {action: 'change', instruction, answer: 'I will prepare this change.'}
            : {action: 'sends', instruction: '', answer: 'Here are the delivery settings.'};
    } });
    const input = await screen.findByRole('textbox', {name: 'Ask Bee…'});
    await user.type(input, 'Open delivery settings{Enter}');
    await user.click(await screen.findByRole('button', {name: 'Change recipient'}));
    expect(await screen.findByText('Who should receive the result?')).toBeVisible();
    await user.type(input, address + '{Enter}');
    await waitFor(() => expect(sent('POST', '/api/cowork/w1/proposals')?.body).toMatchObject({instruction}));
    expect(all('POST', '/api/cowork/w1/conversation')[1]?.body).toMatchObject({
        message: address, history: expect.arrayContaining([{role: 'assistant', text: 'Who should receive the result?'}]),
    });
});

it('opens the sharing controls directly while leaving the access decision to the user', async () => {
    const { user, sent } = openTask({ colleagues: [{id: 'noor', name: 'Noor'}], conversation: () => ({
        action: 'share', answer: 'Choose who may see the task.', instruction: '',
    }) });
    await user.type(await screen.findByRole('textbox', {name: 'Ask Bee…'}), 'Share this task{Enter}');
    expect(await screen.findByRole('combobox', {name: 'Colleague'})).toBeVisible();
    expect(sent('PUT', '/api/cowork/w1/shares')).toBeUndefined();
});

it('can read finished work and return to live progress during another run', async () => {
    const { user } = openTask({ item: {...ITEM, lastStatus: 'running'}, runs: [{...RUN, id: 'live', status: 'running'}, RUN],
        conversation: body => ({action: (body as {message:string}).message.includes('history') ? 'history' : 'result', answer: 'Here it is.', instruction: ''}),
    });
    const input = await screen.findByRole('textbox', {name: 'Ask Bee…'});
    await user.type(input, 'Read my result{Enter}');
    expect(await screen.findByTestId('cowork-task-result-text')).toHaveTextContent(RUN.result);
    await user.type(input, 'Open history{Enter}');
    expect(await screen.findByTestId('cowork-task-runs')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete this task' })).toBeNull();
    await user.click(await screen.findByRole('button', {name: 'Back to the orb'}));
    expect(await screen.findByRole('complementary', {name: 'Steps'})).toBeVisible();
});

it('only deletes the named task after explicit approval at the orb', async () => {
    const { user, all } = openTask({conversation: () => ({action: 'delete', answer: 'Please confirm.', instruction: ''})});
    const ask = async () => user.type(await screen.findByRole('textbox', {name: 'Ask Bee…'}), 'Delete the whole task{Enter}');
    await ask();
    expect(await screen.findByTestId('cowork-task-delete-confirm')).toHaveTextContent(ITEM.title);
    await user.click(screen.getByRole('button', {name: 'Keep it'}));
    expect(all('DELETE', '/api/cowork/w1')).toHaveLength(0);
    await ask();
    await user.click(await screen.findByRole('button', {name: 'Delete task'}));
    expect(all('DELETE', '/api/cowork/w1')).toHaveLength(1);
});

it('renders an answer while the stream is still open, then commits the final reply once', async () => {
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const {user} = openTask({conversation: () => new Response(stream.readable, {headers: {'Content-Type': 'text/event-stream'}})});
    await user.type(await screen.findByRole('textbox', {name: 'Ask Bee…'}), 'What happened?{Enter}');
    const send = (frame: string) => writer.write(new TextEncoder().encode(frame + '\n\n'));
    await send('event: answer\ndata: "Reading mail"');
    expect(await screen.findByText('Reading mail')).toBeVisible();
    await send('event: reply\ndata: {"action":"answer","answer":"Reading mail finished.","instruction":""}');
    await writer.close();
    expect(await screen.findByText('Reading mail finished.')).toBeVisible();
    expect(screen.queryByText('Reading mail')).toBeNull();
});
