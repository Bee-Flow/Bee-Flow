/**
 * One notebook against canned answers: Sources · Notes · Chat, the notes
 * opening on their Markdown mirror and saving what is typed with the version
 * they loaded, the header menu's rename, and the sources' empty state.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { NotebookScreen } from './NotebookScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => {
    const mocks = jest.requireActual('@/shared/testing/screenMocks');
    return { ...mocks.expoRouter(), ...mocks.focusedRouter(() => ({ back: jest.fn(), push: jest.fn() })) };
});
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const put = api.put as jest.Mock;
const post = api.post as jest.Mock;

const NOTEBOOK = {
    id: 'nb1',
    name: 'Test',
    documentContent: '<h1>Plan</h1>',
    documentMd: '# Plan',
    documentFormat: 'html',
    version: 3,
};

function answer(sources: unknown[] = []) {
    get.mockImplementation((path: string) => {
        if (path === '/api/notebooks/nb1') return Promise.resolve({ notebook: NOTEBOOK, sources });
        return Promise.resolve(null);
    });
}

beforeEach(() => {
    get.mockReset();
    put.mockReset();
    put.mockResolvedValue({ success: true, version: 4 });
});

it('shows the three sections and an empty notebook’s way in', async () => {
    answer();
    await renderScreen(<NotebookScreen notebookId="nb1" />);
    expect(await screen.findByText('Test')).toBeTruthy();
    for (const label of ['Sources', 'Notes', 'Chat']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('0 / 0 ready')).toBeTruthy();
    expect(screen.getByText('Add your first source')).toBeTruthy();
});

it('says which stage a source is at', async () => {
    answer([{ id: 's1', name: 'Contract.pdf', type: 'pdf', status: 'processing', stage: 'extracting' }]);
    await renderScreen(<NotebookScreen notebookId="nb1" />);
    expect(await screen.findByText('Contract.pdf')).toBeTruthy();
    expect(screen.getByText('Reading…')).toBeTruthy();
    expect(screen.getByText('0 / 1 ready · 1 sources processing')).toBeTruthy();
});

it('edits the notes and saves them as Markdown with the version it loaded', async () => {
    answer();
    await renderScreen(<NotebookScreen notebookId="nb1" />);
    await screen.findByText('Test');
    await fireEvent.press(screen.getByText('Notes'));
    expect(await screen.findByText('Plan')).toBeTruthy();
    expect(screen.getByText(/written in the web editor/)).toBeTruthy();

    jest.useFakeTimers();
    try {
        await fireEvent.press(screen.getByText('Write'));
        await fireEvent.changeText(screen.getByPlaceholderText(/Markdown works/), '# Plan\n\n- [ ] Call Anna');
        expect(screen.getByText('Unsaved changes')).toBeTruthy();
        await act(async () => {
            jest.advanceTimersByTime(1500);
        });
    } finally {
        jest.useRealTimers();
    }
    expect(put).toHaveBeenCalledWith('/api/notebooks/nb1', { documentContent: '# Plan\n\n- [ ] Call Anna', expectedVersion: 3 });
    expect(await screen.findByText('Saved')).toBeTruthy();
});

it('renames the notebook from the header menu', async () => {
    answer();
    await renderScreen(<NotebookScreen notebookId="nb1" />);
    await screen.findByText('Test');
    await fireEvent.press(screen.getByLabelText('Notebook actions'));
    await fireEvent.press(await screen.findByText('Rename'));
    const field = await screen.findByDisplayValue('Test');
    await fireEvent.changeText(field, 'Q3 review');
    await fireEvent.press(screen.getAllByText('Rename').at(-1) as never);
    await act(async () => undefined);
    expect(put).toHaveBeenCalledWith('/api/notebooks/nb1', { name: 'Q3 review' });
});

it('adds a link, and says in words why the server refused one', async () => {
    answer();
    post.mockRejectedValueOnce(new ApiError('This address points inside the network and cannot be fetched.', { status: 400 }));
    await renderScreen(<NotebookScreen notebookId="nb1" />);
    await screen.findByText('Test');
    await fireEvent.press(screen.getAllByLabelText('Add Source')[0] as never);
    await fireEvent.press(await screen.findByText('Add a link'));
    await fireEvent.changeText(screen.getByPlaceholderText('https://example.com/report'), 'https://intranet.local/x');
    await fireEvent.press(screen.getByText('Add link'));
    expect(post).toHaveBeenCalledWith('/api/notebooks/nb1/sources/url', { url: 'https://intranet.local/x' });
    expect(await screen.findByText('This address points inside the network and cannot be fetched.')).toBeTruthy();
});
