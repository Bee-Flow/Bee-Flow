/**
 * The template chat's composer stays above the keyboard: the modal is its own
 * window, which Android pans rather than resizes, so the body has to avoid
 * the keyboard itself — 'height' on Android, like Screen's avoidKeyboard.
 * And the conversation, kept nowhere else, is not thrown away by Back without
 * asking once a question has been sent.
 */

import { fireEvent, screen, within } from '@testing-library/react-native';
import React from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { TemplateChatModal } from './TemplateChatModal';
import type { Template } from '../model/types';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/sse', () => jest.requireActual('@/shared/testing/screenMocks').silentSse());
// Pulled in through the chat feature's index; ESM jest cannot load.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const TEMPLATE: Template = {
    id: 't1',
    userId: 'u1',
    name: 'Offer letter',
    description: '',
    instructions: '',
    fileName: 'offer.docx',
    storageKey: 'k',
    parameters: ['Name', 'Salary', 'Start date', 'Manager'].map((name) => ({ name, description: '' })),
    knowledgeBaseIds: [],
    createdAt: null,
    updatedAt: null,
};

beforeEach(() => (api.get as jest.Mock).mockResolvedValue(null));

it('lifts the composer above the keyboard, on Android by height', async () => {
    // KeyboardAvoidingView keeps `behavior` to itself; its render sees it.
    const render = jest.spyOn(KeyboardAvoidingView.prototype, 'render');
    await renderScreen(<TemplateChatModal template={TEMPLATE} onClose={jest.fn()} />);
    const body = await screen.findByTestId('template-chat');
    expect(within(body).getByPlaceholderText('What should go in it?')).toBeTruthy();
    const behaviours = render.mock.contexts.map((view) => (view as KeyboardAvoidingView).props.behavior);
    expect(behaviours).toContain(Platform.OS === 'ios' ? 'padding' : 'height');
    render.mockRestore();
});

it('says what to fill in, naming the first three fields', async () => {
    await renderScreen(<TemplateChatModal template={TEMPLATE} onClose={jest.fn()} />);
    expect(await screen.findByText('4 fields to fill in')).toBeTruthy();
    expect(
        screen.getByText('Tell it what goes in Name, Salary, Start date and the rest — or attach a document and let it read them out.'),
    ).toBeTruthy();
});

/** Android's Back on the modal: its onRequestClose, reached from the body inside it. */
const pressBack = () => fireEvent(screen.getByTestId('template-chat'), 'requestClose');

it('closes an untouched chat at once, Back included', async () => {
    const onClose = jest.fn();
    await renderScreen(<TemplateChatModal template={TEMPLATE} onClose={onClose} />);
    await screen.findByText('4 fields to fill in');
    await pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Close this chat?')).toBeNull();
});

it('asks before Back throws a started conversation away', async () => {
    const onClose = jest.fn();
    await renderScreen(<TemplateChatModal template={TEMPLATE} onClose={onClose} />);
    await fireEvent.changeText(await screen.findByPlaceholderText('What should go in it?'), 'Anna starts on 1 May');
    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(await screen.findByText('Anna starts on 1 May')).toBeTruthy();

    await pressBack();
    expect(await screen.findByText('Close this chat?')).toBeTruthy();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Anna starts on 1 May')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Close this chat'));
    await fireEvent.press(await screen.findByText('Close chat'));
    expect(onClose).toHaveBeenCalledTimes(1);
});
