/**
 * Leaving mid-answer asks; staying keeps the screen; a conversation deleted
 * under it lets go without asking, read at the moment the removal comes.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { renderScreen } from '@/shared/testing/renderWithProviders';
import { pressBack, type HeldLeave } from '@/shared/testing/screenMocks';

import { useAnswerLeaveGuard } from './useAnswerLeaveGuard';
import { markDeleted } from '../model/deletedChat';

jest.setTimeout(30_000);

const mockHeld: HeldLeave = { listener: null, dispatch: jest.fn() };

jest.mock('expo-router', () => ({
    useNavigation: jest.requireActual('@/shared/testing/screenMocks').leaveNavigation(() => mockHeld),
}));

function Chat({ streaming, conversationId }: { streaming: boolean; conversationId: string | null }) {
    useAnswerLeaveGuard(streaming, conversationId);
    return <Text>Chat</Text>;
}

beforeEach(() => {
    mockHeld.listener = null;
    mockHeld.dispatch.mockClear();
});

it('does not listen while nothing is being written', async () => {
    await renderScreen(<Chat streaming={false} conversationId="g1" />);
    expect(mockHeld.listener).toBeNull();
});

it('asks, and staying keeps the screen', async () => {
    await renderScreen(<Chat streaming conversationId="g2" />);
    const event = await pressBack(mockHeld);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(await screen.findByText('Stop this answer?')).toBeTruthy();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(mockHeld.dispatch).not.toHaveBeenCalled();
});

it('lets go of a conversation deleted under it, and only that one', async () => {
    await renderScreen(<Chat streaming conversationId="g3" />);
    markDeleted('another');
    expect((await pressBack(mockHeld)).preventDefault).toHaveBeenCalled();

    markDeleted('g3');
    expect((await pressBack(mockHeld)).preventDefault).not.toHaveBeenCalled();
});

it('asks for a new chat that has no id yet', async () => {
    await renderScreen(<Chat streaming conversationId={null} />);
    expect((await pressBack(mockHeld)).preventDefault).toHaveBeenCalled();
});
