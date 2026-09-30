/**
 * A chat's actions (the drawer's, and the list of every conversation's) when
 * the server says no: the pin and the delete say why (a toast, never
 * silence) and leave the actions standing, and only a success closes them.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import type { ConversationSummary } from '@/features/chat/model/types';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { ChatActions } from './ChatActions';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
// Pulled in through the chat feature's index; ESM jest cannot load.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const CHAT = { id: 'c1', title: 'Quarterly plan', pinned: false } as ConversationSummary;
const FAULT = new ApiError('HTTP 502', { status: 502 });
const FAULT_WORDS = 'This is not something you did. Try again in a moment.';

async function renderActions() {
    const onClose = jest.fn();
    const onCloseMenu = jest.fn();
    await renderScreen(<ChatActions conversation={CHAT} menuOpen onCloseMenu={onCloseMenu} onClose={onClose} />);
    return { onClose, onCloseMenu };
}

async function confirmDelete() {
    await fireEvent.press(screen.getByText('Delete'));
    const buttons = await screen.findAllByText('Delete');
    await fireEvent.press(buttons[buttons.length - 1] as never);
}

beforeEach(() => {
    (api.patch as jest.Mock).mockReset();
    (api.delete as jest.Mock).mockReset();
});

it('says why a pin failed, and keeps the actions', async () => {
    (api.patch as jest.Mock).mockRejectedValue(FAULT);
    const { onClose } = await renderActions();
    await fireEvent.press(screen.getByText('Pin to top'));
    expect(await screen.findByText(FAULT_WORDS)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
});

it('closes once a pin has landed', async () => {
    (api.patch as jest.Mock).mockResolvedValue({});
    const { onClose } = await renderActions();
    await fireEvent.press(screen.getByText('Pin to top'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.patch).toHaveBeenCalledWith('/ai/direct/conversations/c1', { pinned: true });
});

it('says why a delete failed, and keeps the actions', async () => {
    (api.delete as jest.Mock).mockRejectedValue(FAULT);
    const { onClose } = await renderActions();
    await confirmDelete();
    expect(await screen.findByText(FAULT_WORDS)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
});

it('closes once a delete has landed', async () => {
    (api.delete as jest.Mock).mockResolvedValue(null);
    const { onClose } = await renderActions();
    await confirmDelete();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await screen.findByText('Conversation deleted')).toBeTruthy();
});

it("opens the rename sheet without a failed pin's error in it", async () => {
    (api.patch as jest.Mock).mockRejectedValue(FAULT);
    await renderActions();
    await fireEvent.press(screen.getByText('Pin to top'));
    await screen.findByText(FAULT_WORDS);
    await fireEvent.press(screen.getByText('Rename'));
    expect(await screen.findByLabelText('Chat title')).toBeTruthy();
    // The toast still says it; the sheet does not repeat it as its own.
    expect(screen.getAllByText(FAULT_WORDS)).toHaveLength(1);
});
