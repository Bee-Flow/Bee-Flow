/**
 * One cell of the transcript. Every cell is this same component, streaming or
 * not, so an answer that finishes is an update of its bubble, not a remount
 * that re-renders the whole markdown tree and resets its code blocks' scroll.
 *
 * Only the streaming cell's selector reads the live turn; a finished cell's
 * always returns `undefined`, so a flush re-renders the one bubble it changes
 * — with every part of the turn drawn into it (liveMessage): the thinking,
 * the tools, the phase line, the cards.
 */

import React, { memo, useMemo } from 'react';


import { MessageBubble } from '@/features/chat/components/message/MessageBubble';
import { liveMessage, type TurnAnswer } from '@/features/chat/model/answer';
import type { ChatMessage } from '@/features/chat/model/types';
import { useTurn, type TurnSource } from '@/shared/stream';

export const TranscriptCell = memo(function TranscriptCell({
    store,
    message,
}: {
    store: TurnSource<TurnAnswer>;
    message: ChatMessage;
}) {
    const turn = useTurn(store, (live) => (message.streaming ? live : undefined));
    const shown = useMemo(() => liveMessage(message, turn), [message, turn]);
    return <MessageBubble message={shown} />;
});
