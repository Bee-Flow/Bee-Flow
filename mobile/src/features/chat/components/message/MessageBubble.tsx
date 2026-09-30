/**
 * One message in the transcript.
 *
 * The layout is asymmetric on purpose. The user's message is a bubble
 * (UserMessage). The assistant's answer is NOT: it runs the full width with no
 * background (AssistantMessage), because the answer is the content of the
 * screen rather than a remark in a conversation.
 *
 * What a message may DO — rate, retry, edit — comes from the transcript's
 * TranscriptActionsContext, so a surface that offers none (a notebook) gets a
 * plain transcript without passing anything.
 */

import React, { memo } from 'react';

import type { ChatMessage } from '@/features/chat/model/types';

import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';

export interface MessageBubbleProps {
    message: ChatMessage;
    /** Live text for the turn currently streaming into this message. */
    streamingText?: string;
}

export const MessageBubble = memo(function MessageBubble({ message, streamingText }: MessageBubbleProps) {
    const shown = streamingText === undefined ? message : { ...message, content: streamingText };
    if (shown.role === 'user') return <UserMessage message={shown} />;
    return <AssistantMessage message={shown} />;
});
