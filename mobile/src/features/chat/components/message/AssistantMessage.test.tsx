/**
 * The answer's anatomy: reasoning, tools, the answer, where it came from and
 * what can be done with it — and what the transcript's actions allow.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import React from 'react';

import { TranscriptActionsContext, type TranscriptActions } from '@/features/chat/hooks/transcriptActions';
import type { ChatMessage } from '@/features/chat/model/types';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { MessageBubble } from './MessageBubble';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const ANSWER: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    content: 'The notice period is **one month**.',
    thinkingParts: [{ id: 't', text: 'Check the handbook', startedAt: 1_000, endedAt: 4_400 }],
    tools: [{ id: 'k', name: 'kb_search', status: 'done', args: { query: 'notice period' }, startTime: 1_000, endTime: 1_840 }],
    sources: [{ title: 'Handbook', page: 12, snippet: 'One month notice…', openable: true }],
    autoSelectedTier: 'fast',
};

async function show(message: ChatMessage, actions: TranscriptActions = {}) {
    await renderScreen(
        <TranscriptActionsContext.Provider value={actions}>
            <MessageBubble message={message} />
        </TranscriptActionsContext.Provider>,
    );
}

it('draws the reasoning, the tools, the answer and its tally', async () => {
    await show(ANSWER, { showSources: true });
    expect(screen.getByText('Thought for 3.4s')).toBeTruthy();
    expect(screen.getByText('Tools Used')).toBeTruthy();
    // The row's time and the card's total, which for one tool are the same.
    expect(screen.getAllByText('840ms')).toHaveLength(2);
    expect(screen.getByText('How I got this answer')).toBeTruthy();
    expect(screen.getByText('Auto → Fast')).toBeTruthy();
    expect(screen.getByText('Handbook · p. 12')).toBeTruthy();
});

it('opens a citation’s passage', async () => {
    await show(ANSWER, { showSources: true });
    await fireEvent.press(screen.getByText('Handbook · p. 12'));
    expect(screen.getByText('One month notice…')).toBeTruthy();
    expect(screen.getByText('Source #1')).toBeTruthy();
});

it('hides the citations where sources may not be shown (fail-closed)', async () => {
    await show(ANSWER);
    expect(screen.queryByText('Handbook · p. 12')).toBeNull();
});

it('offers retry only when the transcript allows it, and on another tier', async () => {
    const onRetry = jest.fn();
    await show(ANSWER, { onRetry, tiers: { auto: { auto: true }, fast: { modelId: 'm-fast' } } });
    await fireEvent.press(screen.getByLabelText('Retry response'));
    expect(onRetry).toHaveBeenCalledWith(ANSWER);
    await fireEvent.press(screen.getByLabelText('Retry with different model'));
    await fireEvent.press(screen.getByText('Fast'));
    expect(onRetry).toHaveBeenLastCalledWith(ANSWER, 'fast');
});

it('names the kind of failure on a failed answer', async () => {
    await show({ id: 'e', role: 'assistant', content: '', error: 'Monthly message limit reached (500).' });
    expect(screen.getByText('Monthly Message Limit Reached')).toBeTruthy();
    expect(screen.getByText('Usage limit reached')).toBeTruthy();
});

it('shows the live status line before the first word', async () => {
    await show({ id: 's', role: 'assistant', content: '', streaming: true, currentPhase: { stage: 'kb_search', detail: null, startedAt: 0 } });
    expect(screen.getByText('Searching knowledge base…')).toBeTruthy();
    expect(screen.queryByLabelText('Retry response')).toBeNull();
});

it('keeps the words that arrived above the error card of a turn that failed halfway', async () => {
    const onRetry = jest.fn();
    const cut: ChatMessage = { id: 'h', role: 'assistant', content: 'The first paragraph.', error: 'The connection to the server was lost.' };
    await show(cut, { onRetry });
    expect(screen.getByText('The first paragraph.')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('The connection to the server was lost.')).toBeTruthy();

    // Still the answer: a long press copies the words, and Retry is under them.
    await fireEvent(screen.getByText('The first paragraph.'), 'longPress');
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('The first paragraph.');
    await fireEvent.press(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledWith(cut);
});

it('marks an answer that was stopped, and keeps its words', async () => {
    await show({ id: 'st', role: 'assistant', content: 'The first half', interrupted: true }, { onRetry: jest.fn() });
    expect(screen.getByText('The first half')).toBeTruthy();
    expect(screen.getByText('Answer stopped early')).toBeTruthy();
    expect(screen.getByLabelText('Retry response')).toBeTruthy();
});
