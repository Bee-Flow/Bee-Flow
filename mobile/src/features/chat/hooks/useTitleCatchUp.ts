/**
 * Looks up a chat's name a few seconds after the turn that makes the server
 * name it (see model/titleCatchUp.ts for why it is not read off the stream).
 * Each look re-reads the conversation and the list only while the cached
 * conversation still has no name. Leaving the screen cancels what is pending.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { invalidateConversation } from './mutations';
import { chatKeys } from '../api/keys';
import { awaitsTitle, TITLE_CHECKS_MS } from '../model/titleCatchUp';
import type { Conversation } from '../model/types';

export function useTitleCatchUp(): (conversationId: string) => void {
    const queryClient = useQueryClient();
    // One array for the life of the screen, emptied and refilled in place,
    // so the unmount cleanup below holds the same one.
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
    useEffect(() => {
        const pending = timers.current;
        return () => pending.splice(0).forEach(clearTimeout);
    }, []);

    return useCallback(
        (conversationId: string) => {
            timers.current.splice(0).forEach(clearTimeout);
            for (const ms of TITLE_CHECKS_MS) {
                timers.current.push(
                    setTimeout(() => {
                        const cached = queryClient.getQueryData<Conversation>(chatKeys.conversation(conversationId));
                        if (awaitsTitle(cached?.title)) invalidateConversation(queryClient, conversationId);
                    }, ms),
                );
            }
        },
        [queryClient],
    );
}
