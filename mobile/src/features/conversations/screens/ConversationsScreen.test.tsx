/**
 * The list of every conversation is where people clean up, so its rows offer
 * what the drawer's do: a long-press or the ⋯ button opens rename, pin and
 * delete. A direct chat goes through the direct-chat endpoints, an agent chat
 * through its agent's.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { ConversationsScreen } from './ConversationsScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
// Pulled in through the chat feature's index; ESM jest cannot load.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const NOW = new Date().toISOString();
const DIRECT = [{ id: 'c1', title: 'Quarterly plan', pinned: false, updated_at: NOW, created_at: NOW }];
const AGENT = [
    { id: 'ac1', agent_id: 'a1', user_id: 'u1', title: 'Invoice question', agent_name: 'Inkoop', agent_avatar: null, created_at: NOW, updated_at: NOW },
];

beforeEach(() => {
    (api.get as jest.Mock).mockImplementation(async (path: string) => {
        if (path === '/ai/direct/conversations') return DIRECT;
        if (path === '/agents/conversations/all') return AGENT;
        return null;
    });
    (api.patch as jest.Mock).mockReset().mockResolvedValue({});
    (api.delete as jest.Mock).mockReset().mockResolvedValue(null);
});

it("pins a direct chat from a long-press, through the direct chat's endpoint", async () => {
    await renderScreen(<ConversationsScreen />);
    await fireEvent(await screen.findByTestId('conversation-c1'), 'longPress');
    await fireEvent.press(await screen.findByText('Pin to top'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/ai/direct/conversations/c1', { pinned: true }));
});

it('opens the same menu from the ⋯ button', async () => {
    await renderScreen(<ConversationsScreen />);
    await fireEvent.press(await screen.findByLabelText('Actions for Quarterly plan'));
    expect(await screen.findByText('Rename')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
});

it("deletes an agent chat through its agent's endpoint, after asking", async () => {
    await renderScreen(<ConversationsScreen />);
    await fireEvent(await screen.findByTestId('conversation-ac1'), 'longPress');
    await fireEvent.press(await screen.findByText('Delete'));
    expect(await screen.findByText('Delete this conversation?')).toBeTruthy();
    expect(api.delete).not.toHaveBeenCalled();
    const buttons = await screen.findAllByText('Delete');
    await fireEvent.press(buttons[buttons.length - 1] as never);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/agents/a1/conversations/ac1'));
});
