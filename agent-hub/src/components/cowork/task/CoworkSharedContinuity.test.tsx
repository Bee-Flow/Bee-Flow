import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { deferred } from '@/test/mcpLibraryKit';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import { panelProps } from '../panels/panelProps.testkit';
import { createPendingBeeDraft, PendingBeeDraft } from '../usePendingBeeDraft';
import CoworkTaskShared from './CoworkTaskShared';
import { ITEM, RUN } from './taskWorld.testkit';

afterEach(() => vi.unstubAllGlobals());

it('keeps the same orb and draft through loading, result and advanced history, and answers in the active tab', async () => {
    const { promise, resolve } = deferred<Response>();
    vi.stubGlobal('fetch', (url: string) => String(url).endsWith('/shared/w1') ? promise : Promise.resolve(jsonResponse({items: []})));
    const { container } = renderWithClient(<CoworkTaskShared {...panelProps({kind: 'shared', id: 'w1'})} />);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', {name: 'Ask Bee…'});
    const orb = container.querySelector('.cowork-orb');
    expect(orb).toBeVisible();
    await user.type(input, 'hello');
    await act(async () => resolve(jsonResponse({role: 'viewer', item: ITEM, runs: [RUN]})));
    expect(await screen.findByTestId('cowork-task-result-text')).toHaveTextContent(RUN.result);
    await user.click(screen.getByRole('button', {name: 'Advanced'}));
    expect(screen.getByRole('textbox', {name: 'Ask Bee…'})).toBe(input);
    expect(input).toHaveValue('hello');
    await user.clear(input);
    await user.type(input, 'Open history{Enter}');
    expect(screen.getByRole('tab', {name: 'History'})).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('button', {name: 'Back to the orb'}));
    expect(screen.getByTestId('cowork-task-runs')).toBeVisible();
    expect(container.querySelector('.cowork-orb')).toBe(orb);
});

it('recovers a failed shared read, and puts a question about other work through on a revoked share', async () => {
    let status = 503;
    stubRecordingFetch(({url}) => url.endsWith('/shared/w1') ? jsonResponse({}, status) : jsonResponse({items: []}));
    const ask = vi.fn();
    const { container } = renderWithClient(<CoworkTaskShared {...panelProps({kind: 'shared', id: 'w1'}, {fillComposer: ask})} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('I couldn’t open this task.');
    expect(screen.queryByTestId('cowork-task-gone')).toBeNull();
    status = 403;
    await user.click(screen.getByRole('button', {name: 'Try again'}));
    expect(await screen.findByTestId('cowork-task-gone')).toBeVisible();
    expect(container.querySelector('.cowork-orb')).toBeVisible();
    await user.type(screen.getByRole('textbox', {name: 'Ask Bee…'}), 'Show my other tasks{Enter}');
    await waitFor(() => expect(ask).toHaveBeenCalledWith('Show my other tasks', 'ask'));
});

it('submits the question from a pending route against the shared task, while preserving the next draft', async () => {
    const read = deferred<Response>();
    const ask = vi.fn();
    vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
        if (String(url).endsWith('/shared/w1')) return read.promise;
        if (String(url).endsWith('/w1/conversation')) {
            ask(JSON.parse(String(options?.body)));
            return Promise.resolve(jsonResponse({action: 'answer', answer: 'It is ready.'}));
        }
        return Promise.resolve(jsonResponse({items: []}));
    });
    const draft = createPendingBeeDraft();
    draft.update({question: 'What is ready?', text: 'Second question'});
    renderWithClient(<PendingBeeDraft.Provider value={draft}><CoworkTaskShared {...panelProps({kind: 'shared', id: 'w1'})} /></PendingBeeDraft.Provider>);
    const input = screen.getByRole('textbox', {name: 'Ask Bee…'});
    expect(input).toHaveValue('Second question');
    await act(async () => read.resolve(jsonResponse({role: 'viewer', item: ITEM, runs: [RUN]})));
    expect(await screen.findByText('It is ready.')).toBeVisible();
    expect(ask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({view: 'shared', message: 'What is ready?'}));
    expect(input).toHaveValue('Second question');
});

it('opens the reader’s import form directly from a shared task and explains organisation access in place', async () => {
    let action = 'org';
    const open = vi.fn();
    stubRecordingFetch(({url}) => {
        if (url.endsWith('/shared/w1')) return jsonResponse({role: 'viewer', item: ITEM, runs: []});
        if (url.endsWith('/conversation')) return jsonResponse({action, section: 'import', answer: 'Opening.'});
        return jsonResponse({items: []});
    });
    renderWithClient(<CoworkTaskShared {...panelProps({kind: 'shared', id: 'w1'}, {open})} />);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', {name: 'Ask Bee…'});
    await user.type(input, 'Open my admin settings{Enter}');
    expect(await screen.findByText('Only administrators of your organisation can see and change these rules.')).toBeVisible();
    expect(open).not.toHaveBeenCalled();
    action = 'templates';
    await user.type(input, 'Import another task{Enter}');
    await waitFor(() => expect(open).toHaveBeenCalledWith({kind: 'templates', section: 'import'}));
});
