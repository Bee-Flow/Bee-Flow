/** A question: edited in place, marked when the shield changed it, and a notice when policy removed it. */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { TranscriptActionsContext } from '@/features/chat/hooks/transcriptActions';
import type { ChatMessage } from '@/features/chat/model/types';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { MessageBubble } from './MessageBubble';

const QUESTION: ChatMessage = { id: 'q1', role: 'user', content: 'Mail anna@example.nl the offer' };

it('rewrites a question and hands the new words to the transcript', async () => {
    const onEdit = jest.fn();
    await renderScreen(
        <TranscriptActionsContext.Provider value={{ onEdit }}>
            <MessageBubble message={QUESTION} />
        </TranscriptActionsContext.Provider>,
    );
    await fireEvent.press(screen.getByLabelText('Edit message'));
    await fireEvent.changeText(screen.getByLabelText('Edit your message'), 'Mail Anna the new offer');
    await fireEvent.press(screen.getByText('Save & Regenerate'));
    expect(onEdit).toHaveBeenCalledWith(QUESTION, 'Mail Anna the new offer');
});

it('names the placeholder that stood for a value in this question', async () => {
    const message: ChatMessage = {
        ...QUESTION,
        privacy: { tokenizedCount: 1, dlpRedactedCount: 0, categories: ['Email'], scanWarnings: [] },
        turnTokenMap: { '[email_1]': 'anna@example.nl' },
    };
    await renderScreen(<MessageBubble message={message} />);
    expect(screen.getByText('[email_1]')).toBeTruthy();
});

it('shows a removed question as a notice, not a bubble', async () => {
    await renderScreen(<MessageBubble message={{ ...QUESTION, content: '[Message removed - policy violation]' }} />);
    expect(screen.getByText('Message removed by security policy')).toBeTruthy();
});
