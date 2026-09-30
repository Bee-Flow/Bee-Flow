/**
 * The leave guard holds a removal only while the draft is dirty, and the
 * confirm variant lets it through on "Leave" and keeps the screen on cancel.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ConfirmProvider } from './confirm';
import { useConfirmLeave, type LeaveWords } from './useLeaveGuard';

jest.setTimeout(30_000);

type Listener = (event: { preventDefault: () => void; data: { action: unknown } }) => void;
const mockNav = { listener: null as Listener | null, dispatch: jest.fn() };

jest.mock('expo-router', () => ({
    useNavigation: () => ({
        addListener: (_name: string, fn: Listener) => {
            mockNav.listener = fn;
            return () => {
                if (mockNav.listener === fn) mockNav.listener = null;
            };
        },
        dispatch: mockNav.dispatch,
    }),
}));

function Harness({ dirty, words }: { dirty: boolean; words?: LeaveWords }) {
    useConfirmLeave(dirty, words);
    return <Text>Editor</Text>;
}

const render = (dirty: boolean, words?: LeaveWords) =>
    renderWithProviders(
        <ConfirmProvider>
            <Harness dirty={dirty} words={words} />
        </ConfirmProvider>,
    );

const back = async () => {
    const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
    await act(async () => mockNav.listener?.(event));
    return event;
};

beforeEach(() => {
    mockNav.listener = null;
    mockNav.dispatch.mockClear();
});

describe('useConfirmLeave', () => {
    it('does not listen while nothing is dirty', async () => {
        await render(false);
        expect(mockNav.listener).toBeNull();
    });

    it('holds Back on a dirty draft and leaves on "Leave"', async () => {
        await render(true);
        const event = await back();
        expect(event.preventDefault).toHaveBeenCalled();
        expect(await screen.findByText('Unsaved changes')).toBeTruthy();
        await fireEvent.press(screen.getByText('Leave'));
        expect(mockNav.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
    });

    it('stays on cancel', async () => {
        await render(true);
        await back();
        expect(await screen.findByText('Unsaved changes')).toBeTruthy();
        await fireEvent.press(screen.getByText('Cancel'));
        expect(mockNav.dispatch).not.toHaveBeenCalled();
    });

    it('asks in the words it is given, where something else than a draft is at stake', async () => {
        await render(true, { title: 'Stop this answer?', message: 'Leaving stops it.', confirmLabel: 'Stop and leave' });
        await back();
        expect(await screen.findByText('Stop this answer?')).toBeTruthy();
        expect(screen.getByText('Leaving stops it.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Stop and leave'));
        expect(mockNav.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
    });
});
