import { useEffect, useEffectEvent } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { ChatMessage } from '../../hooks/useChatEngine/types';

/** Scrolls the transcript to the bottom as it grows: forced after a send, otherwise only when the visitor is near the bottom. */
export function useEmbedAutoScroll(
    messages: ChatMessage[],
    messagesEndRef: RefObject<HTMLDivElement | null>,
    messagesContainerRef: RefObject<HTMLDivElement | null>,
    shouldForceScrollRef: MutableRefObject<boolean>,
): void {
    // Smart auto-scroll: force on send, respect user scroll-back during streaming
    const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
        messagesEndRef.current?.scrollIntoView({ behavior });
    };

    const runMessagesContainerRefEffect = useEffectEvent(() => {
        // Force-scroll when user just sent a message
        if (shouldForceScrollRef.current) {
            shouldForceScrollRef.current = false;
            scrollToBottom('auto');
            return;
        }

        // Smart scroll: only auto-scroll if user is near the bottom
        const container = messagesContainerRef.current;
        if (container) {
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            const isNearBottom = distanceFromBottom < 300;
            if (isNearBottom) {
                const lastMsg = messages[messages.length - 1];
                const streaming = lastMsg?.isStreaming;
                scrollToBottom(streaming ? 'auto' : 'smooth');
            }
        } else {
            scrollToBottom('smooth');
        }
    });
    useEffect(() => { return runMessagesContainerRefEffect(); }, [messages]);
}
