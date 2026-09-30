/**
 * The Chat tab's composer starts a chat by opening one: its words travel in
 * the route and its files are staged for the new chat to send — a photo on
 * its own included. It offers what it can before there is a chat.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import { ChatHomeScreen } from './ChatHomeScreen';
import { takeNewChatFiles } from '../model/newChat';

const mockPush = jest.fn();
const mockPicked: { name: string; mimeType: string; uri: string }[] = [];

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter(() => mockPush));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/features/skills', () => ({ useActiveSkills: () => ({ activeSkillIds: [] }) }));
jest.mock('@/features/knowledge', () => ({ useKnowledgeBases: () => ({ data: [], isLoading: false }) }));
jest.mock('@/features/integrations', () => ({
    INTEGRATION_CATALOG: [],
    allowedByOrg: (catalogue: unknown[]) => catalogue,
    useUserSettings: () => ({ data: { enabledApps: null, orgEnabledIntegrations: null } }),
    useSaveEnabledApps: () => ({ mutate: jest.fn() }),
}));
jest.mock('@/features/chat/hooks/useAttachmentPicker', () => ({
    useAttachmentPicker: () => ({
        attachments: mockPicked,
        pickDocument: jest.fn(),
        pickImage: jest.fn(),
        takePhoto: jest.fn(),
        remove: jest.fn(),
        clear: jest.fn(),
    }),
}));

const PHOTO = { name: 'receipt.jpg', mimeType: 'image/jpeg', uri: 'file:///cache/receipt.jpg' };

beforeEach(() => {
    mockPush.mockClear();
    mockPicked.length = 0;
    takeNewChatFiles();
});

it('opens a new chat with a photo sent on its own, staged for that chat to send', async () => {
    mockPicked.push(PHOTO);
    await renderScreen(<ChatHomeScreen />);
    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(mockPush).toHaveBeenCalledWith('/chat/new');
    expect(takeNewChatFiles()).toEqual([PHOTO]);
});

it('sends the words in the route and the file beside them', async () => {
    mockPicked.push(PHOTO);
    await renderScreen(<ChatHomeScreen />);
    await fireEvent.changeText(screen.getByLabelText('Chat message'), 'What does this cost?');
    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(mockPush).toHaveBeenCalledWith('/chat/new?draft=What%20does%20this%20cost%3F');
    expect(takeNewChatFiles()).toEqual([PHOTO]);
});

it('offers dictation and the apps before there is a chat', async () => {
    await renderScreen(<ChatHomeScreen />);
    expect(screen.getByLabelText('Dictate — speak your instruction')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Message tools'));
    expect(screen.getByText('Apps')).toBeTruthy();
});
