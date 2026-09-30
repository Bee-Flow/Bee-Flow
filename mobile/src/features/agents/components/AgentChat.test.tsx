/**
 * The agent chat's composer asks in the web's words, through the web's key:
 * "Message {name}...", so a translated catalogue reaches the phone too.
 */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { AgentChat } from './AgentChat';
import type { Agent } from '../model/types';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
// Pulled in through the chat feature's index; ESM jest cannot load.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const AGENT = {
    id: 'a1',
    name: 'Inkoopassistent',
    description: null,
    avatar: null,
    model: null,
    owner_id: 'u1',
    is_published: true,
    starter_prompts: null,
} as Agent;

beforeEach(() => {
    (api.get as jest.Mock).mockResolvedValue(null);
});

it("asks in the web's words, with the agent's name", async () => {
    await renderScreen(<AgentChat agent={AGENT} conversationId={null} onConversationId={jest.fn()} />);
    expect(await screen.findByPlaceholderText('Message Inkoopassistent...')).toBeTruthy();
});
