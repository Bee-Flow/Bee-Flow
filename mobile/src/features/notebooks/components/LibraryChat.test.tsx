/**
 * The web's "Insert into document" under a settled notebook answer: offered
 * only when the caller has notes to put it in, and never on a question.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { LibraryChat } from './LibraryChat';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const HISTORY = [
    { id: 'm1', role: 'user' as const, content: 'What does the contract say?' },
    { id: 'm2', role: 'assistant' as const, content: 'It runs until **2027**.' },
];

beforeEach(() => (api.get as jest.Mock).mockResolvedValue(null));

it('inserts a settled answer into the notes', async () => {
    const onInsertAnswer = jest.fn();
    await renderScreen(
        <LibraryChat
            streamPath="/ai/chat/notebook/stream"
            extraBody={{ notebookId: 'nb1' }}
            initialMessages={HISTORY}
            emptyTitle="Empty"
            emptyMessage="Nothing yet"
            onInsertAnswer={onInsertAnswer}
        />,
    );
    const buttons = await screen.findAllByText('Insert into document');
    expect(buttons).toHaveLength(1);
    await fireEvent.press(buttons[0] as never);
    expect(onInsertAnswer).toHaveBeenCalledWith('It runs until **2027**.');
});

it('offers nothing when there are no notes to insert into', async () => {
    await renderScreen(
        <LibraryChat
            streamPath="/ai/chat/notebook/stream"
            extraBody={{ notebookId: 'nb1' }}
            initialMessages={HISTORY}
            emptyTitle="Empty"
            emptyMessage="Nothing yet"
        />,
    );
    await screen.findByText('What does the contract say?');
    expect(screen.queryByText('Insert into document')).toBeNull();
});
