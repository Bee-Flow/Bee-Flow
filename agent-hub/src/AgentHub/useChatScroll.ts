import { useCallback, useEffect, useRef, useState } from 'react';
import followToBottom from './followToBottom';

/**
 * Scroll behaviour of the message list: follow new messages while the reader
 * is near the bottom, jump down right after they send (`shouldForceScrollRef`),
 * and open a loaded conversation at its latest message (`openAtLatest`).
 */
export default function useChatScroll(messages: { isStreaming?: boolean }[]) {
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const shouldForceScrollRef = useRef(false);
    // Bumped right before a loaded conversation's messages are set, in the
    // same batch: the effect below then opens it at its latest message
    // (BFSF-453). State rather than a flag on shouldForceScrollRef: its
    // effect runs on the commit that renders those messages, and the
    // effect's cleanup ends the follow when the next conversation opens.
    const [openAtLatestTick, setOpenAtLatestTick] = useState(0);
    const openAtLatest = useCallback(() => setOpenAtLatestTick(n => n + 1), []);

    const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
        messagesEndRef.current?.scrollIntoView({ behavior });
    };
    useEffect(() => {
        const lastMsg = messages[messages.length - 1];
        const isStreaming = lastMsg?.isStreaming;

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
                scrollToBottom(isStreaming ? 'auto' : 'smooth');
            }
        } else {
            scrollToBottom(isStreaming ? 'auto' : 'smooth');
        }
    }, [messages]);

    // A conversation that was just loaded or restored opens at its latest
    // message, and stays there while images and code blocks finish laying
    // out, until the reader scrolls up (BFSF-453). Without this, only the
    // "near the bottom" rule above applied, and a reloaded list sits at
    // scrollTop 0, far from it. The cleanup stops the follow when the next
    // conversation opens or the hub unmounts.
    useEffect(() => {
        if (openAtLatestTick === 0) return undefined;
        const container = messagesContainerRef.current;
        return container ? followToBottom(container) : undefined;
    }, [openAtLatestTick]);

    return { messagesEndRef, messagesContainerRef, shouldForceScrollRef, openAtLatest };
}
