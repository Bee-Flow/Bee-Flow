/**
 * One agent's conversations, long-pressed: the kit's menu (pin, rename,
 * delete, and a Cancel that is always there), a delete that asks first, and
 * a rename in a sheet that stays open until the name has saved.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { AgentConversationsScreen } from './AgentConversationsScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
// Pulled in through the chat feature's index; ESM jest cannot load.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const NOW = new Date().toISOString();
const ROWS = [{ id: 'c1', agent_id: 'a1', user_id: 'u1', title: 'Invoice question', pinned: false, created_at: NOW, updated_at: NOW }];
const PATH = '/agents/a1/conversations/c1';

beforeEach(() => {
    (api.get as jest.Mock).mockImplementation(async (path: string) => (path === '/agents/a1/conversations' ? ROWS : null));
    (api.patch as jest.Mock).mockReset();
    (api.delete as jest.Mock).mockReset();
});

async function openMenu() {
    await renderScreen(<AgentConversationsScreen id="a1" />);
    await fireEvent(await screen.findByTestId('agent-conversation-c1'), 'longPress');
    await screen.findByText('Pin to top');
}

it('offers pin, rename and delete, and always a Cancel', async () => {
    await openMenu();
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
});

it('deletes only after the person confirms', async () => {
    (api.delete as jest.Mock).mockResolvedValue(null);
    await openMenu();
    await fireEvent.press(screen.getByText('Delete'));
    expect(await screen.findByText('Delete this conversation?')).toBeTruthy();
    expect(api.delete).not.toHaveBeenCalled();

    const buttons = screen.getAllByText('Delete');
    await fireEvent.press(buttons[buttons.length - 1] as never);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(PATH));
});

it('keeps the conversation when the confirmation is cancelled', async () => {
    await openMenu();
    await fireEvent.press(screen.getByText('Delete'));
    await screen.findByText('Delete this conversation?');
    const cancels = screen.getAllByText('Cancel');
    await fireEvent.press(cancels[cancels.length - 1] as never);
    expect(api.delete).not.toHaveBeenCalled();
});

it('says why a delete failed', async () => {
    (api.delete as jest.Mock).mockRejectedValue(new ApiError('HTTP 500', { status: 500 }));
    await openMenu();
    await fireEvent.press(screen.getByText('Delete'));
    await screen.findByText('Delete this conversation?');
    const buttons = screen.getAllByText('Delete');
    await fireEvent.press(buttons[buttons.length - 1] as never);
    expect(await screen.findByText('This is not something you did. Try again in a moment.')).toBeTruthy();
});

it('pins from the menu', async () => {
    (api.patch as jest.Mock).mockResolvedValue(null);
    await openMenu();
    await fireEvent.press(screen.getByText('Pin to top'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(PATH, { pinned: true }));
});

it('renames in a sheet that keeps a refused name up, with the reason', async () => {
    (api.patch as jest.Mock).mockRejectedValueOnce(new ApiError('Title too long.', { status: 400 })).mockResolvedValue(null);
    await openMenu();
    await fireEvent.press(screen.getByText('Rename'));
    const field = await screen.findByLabelText('Conversation title');
    await fireEvent.changeText(field, 'Invoices 2026');
    await fireEvent.press(screen.getByText('Save'));
    expect(await screen.findByText('Title too long.')).toBeTruthy();
    expect(screen.getByLabelText('Conversation title')).toBeTruthy();

    await fireEvent.press(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByLabelText('Conversation title')).toBeNull());
    expect(api.patch).toHaveBeenLastCalledWith(PATH, { title: 'Invoices 2026' });
});
