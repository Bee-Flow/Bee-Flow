// Small hooks of the message column: what the reader has not seen yet, and
// fetching a thread's first message when it is older than the loaded page.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { newestSeq, useLoadOlderMessages, type TeamChatMessage, type TeamChatMessages } from '../../../../api/queries/projectChats';
import useStickToBottom from '../../../../hooks/useStickToBottom';
import { mainConversation, type MessageGroup } from './messageGroups';
import useMarkRead from './useMarkRead';

/** Pages to walk back for a thread's root before giving up (PAGE messages each). */
export const MAX_ROOT_PAGES = 20;

/**
 * How many messages from others arrived while the list was scrolled away from
 * its newest end. `mainMessages` are the ones the list shows.
 */
export function useUnseenCount(mainMessages: TeamChatMessage[], atBottom: boolean, currentUserId: string | null): number {
    const newest = newestSeq(mainMessages);
    // The newest message the reader has had the chance to see.
    const [seen, setSeen] = useState(newest);
    useEffect(() => { if (atBottom) setSeen(newest); }, [atBottom, newest]);
    if (atBottom) return 0;
    return mainMessages.filter(m => m.seq > seen && !m.deleted && !(m.authorKind === 'user' && m.authorUserId === currentUserId)).length;
}

/** Calls `onNew` when a message of the reader's own starts sending (or is sent again) in `groups`. */
export function useOnOwnSend(groups: MessageGroup[], onNew: () => void): void {
    const sendingIds = groups.flatMap(g => g.items)
        .flatMap(i => (i.type === 'pending' && i.pending.status === 'sending' ? [i.pending.clientMsgId] : []));
    const signature = sendingIds.join('|');
    const before = useRef<Set<string>>(new Set());
    const latest = useRef(onNew);
    latest.current = onNew;
    // Layout effect: the new bubble is in the DOM, so scrolling to the bottom includes it.
    useLayoutEffect(() => {
        const fresh = sendingIds.some(id => !before.current.has(id));
        before.current = new Set(sendingIds);
        if (fresh) latest.current();
    }, [signature]);
}

export type ThreadRootState = 'found' | 'loading' | 'missing';

/**
 * A thread can be opened (a task's link, a notification) while its first
 * message is older than the page the chat loaded. Page back until it turns up.
 */
export function useThreadRoot(projectId: string, chatId: string, threadId: string | null, data: TeamChatMessages | undefined): {
    state: ThreadRootState; retry: () => void;
} {
    const older = useLoadOlderMessages(projectId, chatId);
    const pages = useRef(0);
    const [failed, setFailed] = useState(false);
    const found = !threadId || !data || data.messages.some(m => m.id === threadId);
    const exhausted = !!data && !data.hasOlder;
    const give = failed || exhausted || pages.current >= MAX_ROOT_PAGES;
    const { mutate, isPending } = older;
    const count = data?.messages.length ?? 0;

    useEffect(() => {
        if (found || give || isPending) return;
        pages.current += 1;
        mutate(undefined, { onError: () => setFailed(true) });
    }, [found, give, isPending, mutate, count]);

    const retry = () => { pages.current = 0; setFailed(false); };
    return { state: found ? 'found' : give ? 'missing' : 'loading', retry };
}

/**
 * Following the newest message: the scroll handler, the jump to the bottom,
 * the read marker (main list only, and only at the bottom) and the count of
 * messages the reader has not scrolled to.
 */
export function useFollowNewest({ containerRef, projectId, chatId, threadId, groups, messages, currentUserId }: {
    containerRef: RefObject<HTMLElement | null>;
    projectId: string;
    chatId: string;
    threadId: string | null;
    groups: MessageGroup[];
    messages: TeamChatMessage[];
    currentUserId: string | null;
}) {
    const { onScroll, forceStick, isStuck } = useStickToBottom({ containerRef });
    const [atBottom, setAtBottom] = useState(true);
    const jumpToNewest = () => { forceStick(); setAtBottom(true); };
    // Sending (or resending) from further up brings the message into view.
    useOnOwnSend(groups, jumpToNewest);
    useMarkRead(projectId, chatId, !threadId && atBottom);
    const mainMessages = useMemo(() => (threadId ? [] : mainConversation(messages, []).messages), [messages, threadId]);
    const unseen = useUnseenCount(mainMessages, atBottom, currentUserId);
    return { unseen, jumpToNewest, onScroll: () => { onScroll(); setAtBottom(isStuck()); } };
}
